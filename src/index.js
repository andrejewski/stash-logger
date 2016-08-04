import request from 'superagent';

const loggerDefaults = {
  logLevel: 'error',
  logLevels: [
    'log',
    'info',
    'warn',
    'error'
  ],
  bufferMaxPayload: 15 * 1024, // 15 kB
  bufferCheckInterval: 250,   // 1/4 second
  bufferWriteInterval: 1000, // 1 second
  bufferWriteTimeout: 10000, // 10 seconds
  bufferMaxWriteRetries: 3,

  appId: null,
  topic: null,
  context: {},

  handleWindow: typeof window !== 'undefined',
  handleProcess: typeof process !== 'undefined'
};

export class StashLoggerError extends Error {
  constructor() {
    super(...arguments);
    this.name = 'StashLoggerError';
  }
}

export default class StashLogger {
  constructor(parent, options) {
    if (!(parent instanceof StashLogger)) {
      options = parent;
      parent = null;
    }
    this.options = Object.assign(loggerDefaults, options || {});
    this.parent = parent;

    this.options.logLevels.forEach(level => {
      this[level] = function() {
        return this._handleLog(level, arguments);
      };
      this[`${level}Immediately`] = function() {
        return this._handleLog(level, arguments, true);
      };
    });
  }

  attach() {
    if (this.parent) {
      throw new StashLoggerError('Method attach() can only be called on the root logger');
    }
    const {handleWindow, handleProcess} = this.options;
    if (handleWindow) {
      window.addEventListener('error', this._handleWindowLog);
    }
    if (handleProcess) {
      process.on('uncaughtException', this._handleProcessLog);
    }
    this._logBufferInterval = setInterval(this._scheduleLogWrite, this.options.bufferCheckInterval);
    return this;
  }

  detach() {
    if (this.parent) {
      throw new StashLoggerError('Method detach() can only be called on the root logger');
    }
    const {handleWindow, handleProcess} = this.options;
    if (handleWindow) {
      window.removeEventListener('error', this._handleWindowLog);
    }
    if (handleProcess) {
      process.removeListener('uncaughtException', this._handleProcessLog);
    }
    if (this._logBufferInterval) {
      clearInterval(this._logBufferInterval);
      this._logBufferInterval = null;
    }
    return this;
  }

  extend(options) {
    return new StashLogger(this, Object.assign(this.options, options));
  }

  _fatalLevel() {
    const {logLevels} = this.options;
    return logLevels[logLevels.length - 1];
  }

  _handleWindowLog(event) {
    this._handleLog(this._fatalLevel(), [event]);
  }

  _handleProcessLog(error) {
    this._handleLog(this._fatalLevel(), [error]);
  }

  _isImportant(level) {
    const {logLevel, logLevels} = this.options;
    const threshold = logLevels.indexOf(logLevel);
    const importance = logLevels.indexOf(level);
    return importance >= threshold;
  }

  _handleLog(level, args, immediate) {
    if (this._isImportant(level)) {
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
    if (this.options.packagePayload) {
      return this.options.packagePayload(logs);
    }
    const {appId} = this.options;
    return {
      app: {appId},
      traces: logs
    };
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
      .then(() => {
        this._logBuffer = write.remainingLogs;
      })
      .catch(reason => {
        if (reason.origin === 'server') {
          // failover and purge logs
          this._logBuffer = write.remainingLogs;
        } else {
          // throw BIG
          const message = 'Client-side logging error; fix ASAP';
          const error = reason || new StashLoggerError(message);
          throw error;
        }
      });
  }

  _nextWrite() {
    const logs = this._bufferLogs;
    const {bufferMaxPayload} = this.options;
    let index = 0;
    let payload = '';
    while (payload.length < bufferMaxPayload && index < logs.length) {
      const pendingLogs = logs.slice(0, index);
      payload = this._package(pendingLogs);
      index++;
    }
    const remainingLogs = logs.slice(index);
    return {payload, remainingLogs};
  }

  _sendPayload(payload) {
    this._writeAttempts = (this._writeAttempts || 0) + 1;
    this._writePending = true;

    return this._makeRequest(payload)
      .then(res => {
        this._writeAttempts = 0;
        this._lastWrittenAt = Date.now();
      })
      .catch(error => {
        if (error && error.recovery === 'reduce-payload') {
          this.options.bufferMaxPayload = 0.8 * this.options.bufferMaxPayload;
        }

        if (this._writeAttempts >= this.options.bufferMaxWriteRetries) {
          return error;
        }

        return this._sendPayload(payload);
      })
      .finally(() => {
        this._writePending = false;
      });
  }

  _makeRequest(payload) {
    const {endpoint, bufferWriteTimeout} = this.options;
    return new Promise((resolve, reject) => {
      request
        .post(endpoint)
        .send(payload)
        .timeout(bufferWriteTimeout)
        .end((error, res) => {
          if (error) return reject(error);

          const {status} = res;

          if (status >= 500) {
            let message = `Server error ${status}`;
            if (status === 503 || status === 504) {
              message = 'Server is unreachable';
            }
            const reason = new StashLoggerError(res.body.message || message);
            error.origin = 'server';
            return reject(reason);
          }

          if (status >= 400) {
            let message = `Client error ${status}`;
            let recovery = null;
            if (status === 413) {
              message = 'Client log payload too large';
              recovery = 'reduce-payload';
            }
            const reason = new StashLoggerError(res.body.message || message);
            error.origin = 'client';
            error.recovery = recovery;
            return reject(reason);
          }

          resolve(res);
        });
    });
  }
}
