/*
 * processBridge
 * https://github.com/anseki/process-bridge
 *
 * Copyright (c) 2016 anseki
 * Licensed under the MIT license.
 */

'use strict';

var
  RE_MESSAGE_LINE = /^([^\n\r]*)[\n\r]+([\s\S]*)$/,
  options = { // Default Options
    hostModule: 'electron-prebuilt',
    funcGetHostPath: function(moduleExp) { return moduleExp; },
    singleTask: true
  },
  requests = {}, curRequestId = 0,
  childProc, stdioData = '', stderrData = '', waitingRequests, didInit;

function parseMessage(lines, getLine, cb) { // cb(requestId, message)
  var matches, line, lineParts;

  if (arguments.length < 3) {
    cb = getLine;
    getLine = false;
  }

  RE_MESSAGE_LINE.lastIndex = 0;
  while ((matches = RE_MESSAGE_LINE.exec(lines))) {
    line = matches[1];
    lines = matches[2];
    if (getLine) {
      cb(line); // eslint-disable-line callback-return
    } else {
      lineParts = line.split('\t', 2);
      if (lineParts.length < 2 || !lineParts[0] || !lineParts[1]) {
        throw new Error('Invalid message: ' + line);
      }
      cb(+lineParts[0], JSON.parse(lineParts[1])); // eslint-disable-line callback-return
    }
  }
  return lines;
}

function getHostCmd(cb) { // cb(error, hostPath)
  var pathUtil = require('path'), semver = require('semver'),
    version, versionRange, error, hostCmd,
    baseModuleObj = module.parent, targetModuleExp,
    basePackageRoot, targetPackageRoot, basePackageInfo, targetPackageInfo,
    baseDir = pathUtil.dirname(baseModuleObj.filename), targetPath, targetPackagePath;

  function getPackageRoot(startPath) {
    var fs = require('fs'), dirPath = pathUtil.resolve(startPath || ''), parentPath;
    while (true) {
      try {
        fs.accessSync(pathUtil.join(dirPath, 'package.json')); // Check only existence.
        return dirPath;
      } catch (error) { /* ignore */ }
      parentPath = pathUtil.join(dirPath, '..');
      if (parentPath === dirPath) { break; } // root
      dirPath = parentPath;
    }
  }

  function initModule(cb) {
    var npm;
    if (didInit) { throw new Error('Cannot initialize module \'' + options.hostModule + '\''); }
    didInit = true;
    try {
      npm = require('npm');
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') { throw error; }
      npm = require(pathUtil.join( // Retry with full path
        require('child_process').execSync('npm root -g', {encoding: 'utf8'}).replace(/\n+$/, ''),
        'npm'));
    }

    console.warn('Base directory path: %s', baseDir);
    npm.load({prefix: baseDir}, function(error) {
      if (error) { throw error; }
      npm.commands.install(versionRange ? [] : [options.hostModule], function(error) {
        if (error) { throw error; }
        cb();
      });
      // npm.registry.log.on('log', function(message) { console.dir(message); });
    });
  }

  if (options.hostModule) {
    if ((basePackageRoot = getPackageRoot(baseDir))) {
      baseDir = basePackageRoot;
      basePackageInfo = require(pathUtil.join(basePackageRoot, 'package'));
      if (basePackageInfo.dependencies &&
          (versionRange = basePackageInfo.dependencies[options.hostModule]) &&
          !semver.validRange(versionRange)) {
        throw new TypeError('Invalid SemVer Range: ' + versionRange);
      }
    }

    try {
      targetModuleExp = baseModuleObj.require(options.hostModule);
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') {
        error.isRetried = true;
        initModule(function() { getHostCmd(cb); }); // Retry
      }
      return cb(error);
    }

    if (versionRange) {
      // This works as if `module.require.resolve()`
      // targetPath = baseModuleObj.require.resolve(options.hostModule)
      // https://github.com/nodejs/node/blob/master/lib/internal/module.js
      targetPath = baseModuleObj.constructor._resolveFilename( // eslint-disable-line no-underscore-dangle
        options.hostModule, baseModuleObj);
      if (!targetPath) { throw new Error('Cannot get module path'); }

      if ((targetPackageRoot = getPackageRoot(pathUtil.dirname(targetPath)))) {
        targetPackageInfo = require((targetPackagePath = pathUtil.join(targetPackageRoot, 'package')));
        if ((version = targetPackageInfo.version)) {
          if (!semver.valid(version)) { throw new TypeError('Invalid Version: ' + version); }
          if (!semver.satisfies(version, versionRange)) {
            error = new Error('Cannot find module \'' + options.hostModule + '\' version');
            error.code = 'MODULE_NOT_FOUND';
            error.isRetried = true;
            delete require.cache[targetPath]; // Unload forcibly
            delete require.cache[require.resolve(targetPackagePath)]; // Remove cached targetPackageInfo
            initModule(function() { getHostCmd(cb); }); // Retry
            return cb(error);
          }
        }
      }
    }
  }

  return !options.funcGetHostPath ? cb(null, 'node') :
    (hostCmd = options.funcGetHostPath(targetModuleExp)) ?
      cb(null, hostCmd) : cb(new Error('Couldn\'t get command.'));
}

exports.sendRequest = function(message, args, cb) { // cb(error, message)
  var spawn = require('child_process').spawn; // coz, it might not be used

  function writeMessage(message, cb) {
    if (options.singleTask) { requests = {}; }
    requests[++curRequestId] = {cb: cb};
    childProc.stdin.write([curRequestId, JSON.stringify(message)].join('\t') + '\n');
  }

  if (arguments.length < 3) {
    cb = args;
    args = [];
  }

  if (childProc) {
    writeMessage(message, cb);
  } else {
    if (waitingRequests) { // Getting host was already started.
      waitingRequests.push({message: message, cb: cb});
      return;
    }
    waitingRequests = [{message: message, cb: cb}];

    console.warn('Start child process...');
    getHostCmd(function(error, hostCmd) {
      if (error) { return cb(error); }

      childProc = spawn(hostCmd, args, {stdio: 'pipe'});
      childProc.on('exit', function(code) {
        console.warn('Child process exited with code: %d', code);
        if (childProc) { childProc = null; }
      });

      childProc.stdout.setEncoding('utf8');
      childProc.stdout.on('data', function(chunk) {
        stdioData = parseMessage(stdioData + chunk, function(requestId, message) {
          if (requests[requestId]) {
            // Check again. (requests that has not curRequestId was already deleted in writeMessage().)
            if (!options.singleTask || requestId === curRequestId) {
              requests[requestId].cb(null, message);
            }
            delete requests[requestId];
          } else {
            console.warn('Unknown or dropped response: %s', requestId);
          }
        });
      });

      childProc.stderr.setEncoding('utf8');
      childProc.stderr.on('data', function(chunk) {
        stderrData = parseMessage(stderrData + chunk, true, function(line) {
          throw new Error(line);
        });
      });

      childProc.stdin.on('error', function(error) { throw error; });
      childProc.stdout.on('error', function(error) { throw error; });
      childProc.stderr.on('error', function(error) { throw error; });

      if (options.singleTask) {
        waitingRequests = waitingRequests[waitingRequests.length - 1];
        writeMessage(waitingRequests.message, waitingRequests.cb);
      } else {
        waitingRequests.forEach(function(request) {
          writeMessage(request.message, request.cb);
        });
      }
      waitingRequests = null;
    });
  }
};

exports.closeHost = function() {
  if (childProc) {
    childProc.stdin.end();
    childProc = null;
  }
};

exports.receiveRequest = function(cb) { // cb(message, cbResponse), cbResponse(message)
  function writeMessage(requestId, message) {
    if (requests[requestId]) {
      // Check again. (requests that has not curRequestId was already deleted in stdin.on('data').)
      if (!options.singleTask || requestId === curRequestId) {
        console.log([requestId, JSON.stringify(message)].join('\t'));
      }
      delete requests[requestId];
    } // else Unknown or dropped request
  }

  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function(chunk) {
    stdioData = parseMessage(stdioData + chunk, function(requestId, message) {
      if (options.singleTask) { requests = {}; }
      requests[(curRequestId = requestId)] = true;
      cb(message, function(message) { writeMessage(requestId, message); });
    });
  });
  process.stdin.on('error', function(error) { console.error(error); });
};

exports.setOptions = function(newOptions) {
  if (newOptions) {
    Object.keys(newOptions).forEach(function(optionName) {
      if (options.hasOwnProperty(optionName)) {
        options[optionName] = newOptions[optionName];
      }
    });
  }
  return options;
};
