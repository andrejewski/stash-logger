import request from 'superagent';

const levels = [
  'log',
  'info',
  'debug',
  'warn',
  'error'
];

function isValidLogLevel(baseLevel, level) {
  return logLevels.indexOf(level) >= logLevels.indexOf(baseLevel);
}

function takeUntil(predicate, map, list) {
  if (!list.length) return null;
  const len = list.length;
  let index = 1;
  let result = map([list[0]]);
  while(!predicate(result) && index < len) {
    result = map(list.slice(0, index++));
  }
  const remaining = list.slice(index);
  return {result, remaining};
}

const loggerDefaults = {
  logLevel: 'error',
  bufferMaxPayload: 15 * 1024, // 15 kB
  bufferCheckInterval: 250,   // 1/4 second
  bufferWriteInterval: 1000, // 1 second
  bufferWriteTimeout: 10000, // 10 seconds
  bufferMaxWriteRetries: 3,

  appId: null,
  topic: null,
  context: {}
};

const isBrowser = typeof window !== 'undefined';
const isNode = typeof exports !== 'undefined';

export default class StashLogger {
    constructor(parent, options) {
      if (!(parent instanceof StashLogger)) {
        options = parent;
        parent = null;
      }
      this.options = Object.assign(loggerDefaults, options || {});
      this.parent = parent;

      logLevels.forEach(level => {
        this[level] = function() {
          return this._handleLog(level, arguments);
        };
        this[`${level}Immediately`] = function() {
          return this._handleLog(level, arguments, true);
        };
      });

      this.attach();
    }

    attach() {
      if (this.parent) return;
      if (isBrowser) {
        window.addEventListener('error', this._handleWindowLog);
      }
      if (isNode) {
        process.on('uncaughtException', this._handleNodeLog);
      }
      this._logBufferInterval = setInterval(this._scheduleLogWrite, this.options.bufferCheckInterval);
    }

    detach() {
      if (this.parent) return;
      if (isBrowser) {
        window.removeEventListener('error', this._handleWindowLog);
      }
      if (isNode) {
        process.removeListener('uncaughtException', this._handleNodeLog);
      }
      if (this._logBufferInterval) {
        clearInterval(this._logBufferInterval);
        this._logBufferInterval = null;
      }
    }

    extend(options) {
      return new StashLogger(this, Object.assign(this.options, options));
    }

    _handleWindowLog(event) {
      this._handleLog('error', [event]);
    }

    _handleNodeLog(error) {
      this._handleLog('error', [event]);
    }

    _handleConsoleLog(method, args) {
      this._handleLog(method, args);
    }

    _handleLog(level, args, immediate) {
      if (isValidLogLevel(this.options.logLevel, level)) {
        const args = Array.prototype.slice.call(args, 0);
        if (immediate) {
          return this._logImmediately(level, args);
        }
        this._logEventually(level, args);
      }
    }

    _buildLog(level, raw, context) {
      const message = JSON.stringify({raw, context});
      const now = (new Date()).toISOString();
      return {
        level,
        message,
        time: now,
        topic: this.options.topic
      };
    }

    _logEventually(level, logs, context = {}) {
      const newContext = Object.assign(this.options.context, context);
      if (this.parent) {
        return this.parent._logEventually(level, logs, newContext);
      }
      logs = logs.map(log => this._buildLog(level, log, newContext));
      return this._bufferLogs(logs);
    }

    _logImmediately(level, logs, context = {}) {
      const newContext = Object.assign(this.options.context, context);
      if (this.parent) {
        return this.parent._logImmediately(level, logs, newContext);
      }
      logs = logs.map(log => this._buildLog(level, log, newContext));
      return this._sendLogs(this._package(logs));
    }

    _bufferLogs(logs) {
      logs.forEach(log => this._logBuffer.push(log));
    }

    _package(logs) {
      const {appId} = this.options;
      return JSON.stringify({
        app: {appId},
        traces: logs
      });
    }

    _scheduleLogWrite() {
      if (this._writePending || this._lastWrittenAt + this.options.bufferWriteInterval > Date.now()) {
        return;
      }

      const write = this._nextWrite();
      if (!write.payload) {
        return;
      }

      return this._sendPayload(write.payload)
        .then(() => this._logBuffer = write.logs)
        .catch(reason => {
          if (reason.origin === 'server') {
            // failover and purge logs
            this._logBuffer = write.logs;
          } else {
            // throw BIG
            console.error('Stash logger error that is your fault; fix ASAP', reason);
          }
        });
    }

    _nextWrite() {
      const logs = this._bufferLogs;
      const payloadExceeded = payload => payload.length > this.options.bufferMaxPayload;
      const {result, remaining} = takeUntil(payloadExceeded, logs => this._package(logs), logs);
      return {
        payload: result,
        logs: remaining
      };
    }

    _sendPayload(payload, uuid) {
      if (this._writeAttempts > this.options.bufferMaxWriteRetries) {
        const error = new Error('StashLogger: bufferMaxWriteRetries reached; write discarded');
        error.origin = 'server';
        return Promise.reject(error);
      }

      this._writeAttempts++;
      this._writePending = true;

      const {endpoint, bufferWriteTimeout} = this.options;
      return new Promise((resolve, reject) => {
        return request
          .post(endpoint)
          .send(payload)
          .timeout(bufferWriteTimeout)
          .end((error, res) => {
            this._writePending = false;
            this._lastWrittenAt = Date.now();

            if (error) return reject(error);

            const {status} = res;
            const serverDown = status === 503 || status === 504;
            const requestTooBig = status === 413;

            if (serverDown) {
              return this._sendPayload(payload).then(resolve, reject);
            }

            if (requestTooBig) {
              this.options.bufferMaxPayload = 0.8 * this.options.bufferMaxPayload;
              return this._sendPayload(payload).then(resolve, reject);
            }

            if (status >= 500) {
              const reason = new Error(res.body.message || `Server error ${status}`);
              error.origin = 'server';
              return reject(reason);
            }

            if (status >= 400) {
              const reason = new Error(res.body.message || `Client error ${status}`)
              error.origin = 'client';
              return reject(reason);
            }

            resolve(res.body);
          });
      });
    }
}
