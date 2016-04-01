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

  options = { // Default options
    hostModule: 'electron-prebuilt',
    funcGetHostPath: function(moduleExports) { return moduleExports; },
    dependenciesSatisfy: true,
    ipc: true,
    singleTask: true
  },

  requests = {}, curRequestId = 0, tranRequests = {}, retryTimer,
  childProc, stdioData = '', stderrData = '', waitingRequests, triedInit;

/**
 * Callback that handles the parsed message object.
 * @callback ProcMessage
 * @param {string} requestId - ID of the message.
 * @param {Object} message - The message object.
 */

/**
 * Normalize an IPC message, and call `ProcMessage` callback with `requestId`.
 * @param {Object} message - IPC message.
 * @param {ProcMessage} cb - Callback function that is called.
 * @returns {any} result - Something that was returned by `cb`.
 */
function parseIpcMessage(message, cb) {
  var requestId;
  if (message._requestId == null) { // eslint-disable-line eqeqeq
    throw new Error('Invalid message: ' + JSON.stringify(message));
  }
  requestId = message._requestId;
  delete message._requestId;
  return cb(+requestId, message);
}

/**
 * Normalize an IPC message from input stream, and call `ProcMessage` callback with `requestId`.
 *    Extract those from current input stream that includes chunk data, and return remaining data.
 * @param {string} lines - current input stream.
 * @param {boolean} [getLine] - Get a line as plain string.
 * @param {ProcMessage|Function} cb - Callback function that is called. It is called with a line if `getLine` is `true`.
 * @returns {string} lines - remaining data.
 */
function parseMessageLines(lines, getLine, cb) {
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

/**
 * @param {Function} cbReceiveHostCmd - Callback function that is called with host command.
 * @param {Function} cbInitDone - Callback function that is called when module was initialized.
 * @returns {any} result - Something that was returned by `cbReceiveHostCmd`.
 */
function getHostCmd(cbReceiveHostCmd, cbInitDone) { // cbReceiveHostCmd(error, hostPath)
  var pathUtil = require('path'), semver = require('semver'),
    baseModuleObj = module.parent,
    baseDir = pathUtil.dirname(baseModuleObj.filename),
    basePackageRoot, basePackageInfo, error,
    hostVersionRange, hostModuleExports, hostCmd;

  function getPackageRoot(startPath) {
    var fs = require('fs'),
      dirPath = pathUtil.resolve(startPath || ''), parentPath;
    while (true) {
      try {
        fs.accessSync(pathUtil.join(dirPath, 'package.json')); // Check only existence.
        return dirPath;
      } catch (error) { /* ignore */ }
      parentPath = pathUtil.join(dirPath, '..');
      if (parentPath === dirPath) { break; } // root
      dirPath = parentPath;
    }
    return null;
  }

  function initModule(cb) {
    var npm, npmPath;
    if (triedInit) { throw new Error('Cannot initialize module'); }
    triedInit = true;

    try {
      npm = require('npm');
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') { throw error; }
      // Retry with full path
      console.warn('Try to get npm in global directory.');
      npm = require(
        (npmPath = pathUtil.join(
          require('child_process').execSync('npm root -g', {encoding: 'utf8'}).replace(/\n+$/, ''),
          'npm'))
        );
    }

    console.info('Base directory path: %s', baseDir);
    npm.load({prefix: baseDir,
      npat: false, dev: false, production: true, // disable `devDependencies`
      loglevel: 'silent', spin: false, progress: false // disable progress indicator
    }, function(error) {
      var npmSpawn, npmSpawnPath;
      if (error) { throw error; }

      // Wrap `spawn.js` for dropping output from child.
      try {
        npmSpawnPath = require.resolve(
          pathUtil.join(
            pathUtil.dirname(require.resolve(npmPath || 'npm')), // npmPath is package dir
            'utils/spawn.js'));
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

      // `hostVersionRange` means that `options.hostModule` and version are specified in `package.json`.
      npm.commands.install(hostVersionRange ? [] : [options.hostModule], function(error) {
        if (error) { throw error; }
        cb();
      });
      // npm.registry.log.on('log', function(message) { console.dir(message); });
    });
  }

  function isSatisfiedModule(moduleName, versionRange) {
    var modulePath, packageRoot, packagePath, packageInfo, satisfied = false;

    console.info('Check version of: %s', moduleName);
    try {
      // modulePath = baseModuleObj.require.resolve(moduleName)
      // This works as if `module.require.resolve()`
      // https://github.com/nodejs/node/blob/master/lib/internal/module.js
      modulePath = baseModuleObj.constructor._resolveFilename(moduleName, baseModuleObj);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') { throw error; }
      return false;
    }

    if (!(packageRoot = getPackageRoot(pathUtil.dirname(modulePath)))) {
      throw new Error('Cannot find module \'' + moduleName + '\' path');
    }
    packageInfo = require( // `resolve` to make sure
      (packagePath = require.resolve(pathUtil.join(packageRoot, 'package.json'))));

    if (!semver.valid(packageInfo.version)) {
      throw new Error('Invalid \'' + moduleName + '\' version: ' + packageInfo.version);
    }
    satisfied = semver.satisfies(packageInfo.version, versionRange);

    delete require.cache[modulePath]; // Unload forcibly
    delete require.cache[packagePath]; // Remove cached targetPackageInfo
    baseModuleObj.constructor._pathCache = {}; // Remove cached pathes
    return satisfied;
  }

  if ((basePackageRoot = getPackageRoot(baseDir))) {
    baseDir = basePackageRoot;
    basePackageInfo = require(pathUtil.join(basePackageRoot, 'package'));
  }

  if (options.hostModule) {
    if (basePackageInfo && basePackageInfo.dependencies &&
        (hostVersionRange = basePackageInfo.dependencies[options.hostModule]) &&
        !semver.validRange(hostVersionRange)) {
      throw new Error('Invalid SemVer Range: ' + hostVersionRange);
    }

    try {
      hostModuleExports = baseModuleObj.require(options.hostModule);
      if (hostVersionRange && !isSatisfiedModule(options.hostModule, hostVersionRange)) {
        error = new Error('Cannot find satisfied version of module \'' + options.hostModule + '\'.');
        error.code = 'MODULE_NOT_FOUND';
        error.isRetried = true;
        initModule(function() {
          if (cbInitDone) { cbInitDone(); }
          getHostCmd(cbReceiveHostCmd); // Retry
        });
        return cbReceiveHostCmd(error);
      }
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') {
        error.isRetried = true;
        initModule(function() {
          if (cbInitDone) { cbInitDone(); }
          getHostCmd(cbReceiveHostCmd); // Retry
        });
      }
      return cbReceiveHostCmd(error);
    }
  }

  if (options.dependenciesSatisfy) {
    if (!hostVersionRange) {
      throw new Error('`options.hostModule` and `package.json` are required.');
    }
    if (basePackageInfo.dependencies &&
        !(Object.keys(basePackageInfo.dependencies).every(function(moduleName) {
          return moduleName === options.hostModule || // options.hostModule was already checked.
            isSatisfiedModule(moduleName, basePackageInfo.dependencies[moduleName]);
        }))) {
      error = new Error('Cannot find satisfied version of dependencies.');
      error.code = 'MODULE_NOT_FOUND';
      error.isRetried = true;
      initModule(function() {
        if (cbInitDone) { cbInitDone(); }
        getHostCmd(cbReceiveHostCmd); // Retry
      });
      return cbReceiveHostCmd(error);
    }
  }

  return !options.funcGetHostPath ? cbReceiveHostCmd(null, 'node') :
    (hostCmd = options.funcGetHostPath(hostModuleExports)) ?
      cbReceiveHostCmd(null, hostCmd) : cbReceiveHostCmd(new Error('Couldn\'t get command.'));
}

/**
 * Callback that receives result from host.
 * @callback CbResponse
 * @param {Error|null} error - ID of the message.
 * @param {Object} message - The message object.
 */

/**
 * @param {Object} message - Message that is sent.
 * @param {Array<string>} args - Arguments that are passed to host command.
 * @param {CbResponse} cbResponse - Callback function that is called when host returned response.
 * @param {Function} [cbInitDone] - Callback function that is called when target module was
 *    initialized if it is done.
 * @returns {void}
 */
exports.sendRequest = function(message, args, cbResponse, cbInitDone) {
  var spawn = require('child_process').spawn;

  // Recover failed IPC-sending.
  // In some environment, IPC message does not reach to child, with no error and return value.
  function sendIpc(message) {
    var requestIds;
    clearTimeout(retryTimer);
    if (message) { tranRequests[message._requestId] = message; }
    if ((requestIds = Object.keys(tranRequests)).length) {
      if (!childProc) { throw new Error('Child process already exited.'); }
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
    cbResponse = args;
    args = [];
  }

  if (childProc) {
    sendMessage(message, cbResponse);
  } else {
    if (waitingRequests) { // Getting host was already started.
      if (options.singleTask) {
        waitingRequests = [{message: message, cb: cbResponse}];
      } else {
        waitingRequests.push({message: message, cb: cbResponse});
      }
      return;
    }
    waitingRequests = [{message: message, cb: cbResponse}];

    console.info('Start child process...');
    getHostCmd(function(error, hostCmd) {
      if (error) { cbResponse(error); return; }

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

/**
 * @param {boolean} force - Disconnect immediately.
 * @returns {void}
 */
exports.closeHost = function(force) {
  if (childProc) {
    if (force) {
      if (options.ipc) {
        childProc.disconnect();
      } else {
        childProc.stdin.end();
      }
      childProc = null;
    } else {
      requests = {}; // Ignore all response.
      tranRequests = {}; // Cancel all requests.
      exports.sendRequest({_close: true}, [], function() {});
    }
  }
};

/**
 * Callback that handles the response message object.
 * @callback ProcResponse
 * @param {Object} message - The message object.
 */

/**
 * Callback that receives result that is returned to client.
 * @callback CbRequest
 * @param {Object} message - The request message object.
 * @param {ProcResponse} cb - Callback function that is called with response message.
 */

/**
 * @param {CbRequest} cbRequest - Callback function that is called when received request.
 * @param {Function} cbClose - Callback function that is called when host is closed by main.
 * @returns {void}
 */
exports.receiveRequest = function(cbRequest, cbClose) {
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
    if (message._close) {
      closed = true; // Avoid doing sendMessage() even if cbClose() failed.
      if (cbClose) {
        cbClose();
        cbClose = null;
      } else {
        throw new Error('Process is exited forcedly.');
      }
      return;
    }
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
      if (cbClose) {
        cbClose();
        cbClose = null;
      }
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
      if (cbClose) {
        cbClose();
        cbClose = null;
      }
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
