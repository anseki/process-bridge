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
  IPC_RETRY_INTERVAL = 1000,
  options = { // Default Options
    hostModule: 'electron-prebuilt',
    funcGetHostPath: function(moduleExp) { return moduleExp; },
    ipc: true,
    singleTask: true
  },
  requests = {}, curRequestId = 0, tranRequests = {}, retryTimer,
  childProc, stdioData = '', stderrData = '', waitingRequests, didInit;

function parseIpcMessage(message, cb) { // cb(requestId, message)
  var requestId;
  if (message._requestId == null) { // eslint-disable-line eqeqeq
    throw new Error('Invalid message: ' + JSON.stringify(message));
  }
  requestId = message._requestId;
  delete message._requestId;
  return cb(+requestId, message);
}

function parseMessageLines(lines, getLine, cb) { // cb(requestId, message)
  var matches, line, lineParts;

  if (arguments.length < 3) {
    cb = getLine;
    getLine = false;
  }

  RE_MESSAGE_LINE.lastIndex = 0;
  while ((matches = RE_MESSAGE_LINE.exec(lines))) {
    line = matches[1];
    lines = matches[2];
    if (line === '') {
      continue;
    } else if (getLine) {
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

function getHostCmd(cb, cbInitDone) { // cb(error, hostPath)
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

    console.info('Base directory path: %s', baseDir);
    npm.load({prefix: baseDir, loglevel: 'silent', spin: false, progress: false}, function(error) {
      var npmSpawn, npmSpawnPath;
      if (error) { throw error; }

      // Wrap `spawn.js` and drop output from child.
      npmSpawnPath = require.resolve(
        pathUtil.join(pathUtil.dirname(require.resolve('npm')), 'utils/spawn.js'));
      try {
        require(npmSpawnPath);
      } catch (error) {
        throw error.code === 'MODULE_NOT_FOUND' ?
          new Error('Unknown version of npm') : error;
      }
      npmSpawn = require.cache[npmSpawnPath].exports;
      if (typeof npmSpawn !== 'function') { throw new Error('Unknown version of npm or spawn.js'); }
      require.cache[npmSpawnPath].exports = function(cmd, args, options) {
        console.warn('Spawn in silent-mode: %s %s', cmd, args.join(' '));
        options.stdio = 'ignore';
        return npmSpawn(cmd, args, options);
      };

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
        initModule(function() {
          if (cbInitDone) { cbInitDone(); }
          getHostCmd(cb); // Retry
        });
      }
      return cb(error);
    }

    if (versionRange) {
      // This works as if `module.require.resolve()`
      // targetPath = baseModuleObj.require.resolve(options.hostModule)
      // https://github.com/nodejs/node/blob/master/lib/internal/module.js
      targetPath = baseModuleObj.constructor._resolveFilename(
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
            initModule(function() {
              if (cbInitDone) { cbInitDone(); }
              getHostCmd(cb); // Retry
            });
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

exports.sendRequest = function(message, args, cb, cbInitDone) { // cb(error, message)
  var spawn = require('child_process').spawn;

  // Recover failed IPC-sending.
  // In some environment, IPC message does not reach to child, with no error and return value.
  function sendIpc(message) {
    var requestIds;
    clearTimeout(retryTimer);
    if (!childProc) { throw new Error('Child process already exited.'); }
    if (message) { tranRequests[message._requestId] = message; }
    if ((requestIds = Object.keys(tranRequests)).length) {
      requestIds.forEach(function(requestId) {
        console.info('Try to send IPC message: %d', +requestId);
        childProc.send(tranRequests[requestId]);
      });
      retryTimer = setTimeout(sendIpc, IPC_RETRY_INTERVAL);
    }
  }

  function sendMessage(message, cb) {
    if (!childProc) { throw new Error('Child process already exited.'); }
    if (options.singleTask) { requests = {}; }
    requests[++curRequestId] = {cb: cb};
    if (options.ipc) {
      message._requestId = curRequestId;
      sendIpc(message);
    } else {
      childProc.stdin.write([curRequestId, JSON.stringify(message)].join('\t') + '\n');
    }
  }

  function procResponse(requestId, message) {
    if (requests[requestId]) {
      // Check again. (requests that has not curRequestId was already deleted in sendMessage().)
      if (!options.singleTask || requestId === curRequestId) {
        requests[requestId].cb(null, message);
      }
      delete requests[requestId];
    } else {
      console.warn('Unknown or dropped response: %d', +requestId);
    }
  }

  if (arguments.length < 3) {
    cb = args;
    args = [];
  }

  if (childProc) {
    sendMessage(message, cb);
  } else {
    if (waitingRequests) { // Getting host was already started.
      if (options.singleTask) {
        waitingRequests = [{message: message, cb: cb}];
      } else {
        waitingRequests.push({message: message, cb: cb});
      }
      return;
    }
    waitingRequests = [{message: message, cb: cb}];

    console.info('Start child process...');
    getHostCmd(function(error, hostCmd) {
      if (error) { return cb(error); }

      childProc = spawn(hostCmd, args, {stdio: options.ipc ? ['ipc', 'pipe', 'pipe'] : 'pipe'});

      childProc.on('exit', function(code, signal) {
        var error;
        console.info('Child process exited with code: %s', code);
        childProc = null;
        if (code !== 0) {
          error = new Error('Child process exited with code: ' + code);
          error.code = code;
          error.signal = signal;
          throw error;
        }
      });

      childProc.on('error', function(error) { throw error; });

      childProc.stderr.setEncoding('utf8');
      childProc.stderr.on('data', function(chunk) {
        stderrData = parseMessageLines(stderrData + chunk, true,
          function(line) { throw new Error(line); });
      });
      childProc.stderr.on('error', function(error) { throw error; });

      if (options.ipc) {

        childProc.on('message', function(message) {
          parseIpcMessage(message, function(requestId, message) {
            if (message._accepted) { // to recover failed IPC-sending
              delete tranRequests[requestId];
              return;
            }
            procResponse(requestId, message);
          });
        });

        childProc.on('disconnect', function() {
          console.info('Child process disconnected');
          childProc = null;
        });

      } else {

        childProc.stdout.setEncoding('utf8');
        childProc.stdout.on('data', function(chunk) {
          stdioData = parseMessageLines(stdioData + chunk, procResponse);
        });
        childProc.stdout.on('error', function(error) { throw error; });

        childProc.stdin.on('error', function(error) { throw error; });

        childProc.on('close', function(code) {
          console.info('Child process pipes closed with code: %s', code);
          childProc = null;
        });

      }

      waitingRequests.forEach(function(request) { sendMessage(request.message, request.cb); });
      waitingRequests = null;
    }, cbInitDone);
  }
};

exports.closeHost = function() {
  if (childProc) {
    if (options.ipc) {
      childProc.disconnect();
    } else {
      childProc.stdin.end();
    }
    childProc = null;
  }
};

exports.receiveRequest = function(cbRequest, cbClose) { // cbRequest(message, cbResponse(message))
  var closed;

  function sendMessage(requestId, message) {
    if (closed) { throw new Error('Connection already disconnected.'); }
    if (requests[requestId]) {
      // Check again. (requests that has not curRequestId was already deleted in stdin.on('data').)
      if (!options.singleTask || requestId === curRequestId) {
        if (options.ipc) {
          message._requestId = requestId;
          process.send(message);
        } else {
          console.log([requestId, JSON.stringify(message)].join('\t'));
        }
      }
      requests[requestId] = false;
    } // else: Unknown or dropped request
  }

  function procRequest(requestId, message) {
    if (requests.hasOwnProperty(requestId)) { return; } // Duplicated request
    if (options.singleTask) {
      Object.keys(requests).forEach(function(requestId) { requests[requestId] = false; });
    }
    requests[(curRequestId = requestId)] = true;
    cbRequest(message, function(message) { sendMessage(requestId, message); });
  }

  if (options.ipc) {

    process.on('message', function(message) {
      parseIpcMessage(message, function(requestId, message) {
        process.send({_requestId: requestId, _accepted: true}); // to recover failed IPC-sending
        procRequest(requestId, message);
      });
    });

    process.on('disconnect', function() {
      closed = true;
      cbClose();
    });

  } else {

    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function(chunk) {
      stdioData = parseMessageLines(stdioData + chunk, procRequest);
    });
    process.stdin.on('error', function(error) { console.error(error); });

    process.stdin.on('close', function() {
      closed = true;
      cbClose();
    });

  }
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
