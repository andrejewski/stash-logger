import request from 'superagent';

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
    this.options = Object.assign(this.defaults(), options || {});
    this.parent = parent;
    this._logBuffer = [];

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

  extend(options = {}) {
    return new StashLogger(this, Object.assign({}, this.options, options));
  }

  buffer() {
    return this._logBuffer.slice(0);
  }

  // @Override
  makeLog(level, raw, context) {
    const message = JSON.stringify({raw, context});
    const now = (new Date()).toISOString();
    return {
      level,
      message,
      time: now,
      topic: this.options.topic
    };
  }

  // @Override
  makePayload(logs) {
    const {appId} = this.options;
    return {
      app: {appId},
      traces: logs
    };
  }

  // @Override
  defaults() {
    return {
      logLevel: 'error',
      logLevels: [
        'log',
        'info',
        'warn',
        'error'
      ],

      bufferMaxPayloadSize: 15 * 1024, // 15 kB
      bufferCheckInterval: 250,   // 1/4 second
      bufferWriteInterval: 1000, // 1 second
      bufferMaxWriteRetries: 3,

      requestUrl: '/logs',
      requestTimeout: 10000, // 10 seconds

      appId: null,
      topic: null,
      context: {},

      handleWindow: typeof window !== 'undefined',
      handleProcess: typeof process !== 'undefined'
    };
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

  _handleLog(level, params, immediate = false, ctx) {
    if (!(ctx || this._isImportant(level))) {
      return;
    }

    const {context} = this.options;
    const sharedContext = Object.assign(context, ctx || {});
    if (this.parent) {
      return this.parent._handleLog(level, params, immediate, sharedContext);
    }

    const args = Array.prototype.slice.call(params, 0);
    if (immediate) {
      return this._logImmediately(level, args, sharedContext);
    }
    this._logEventually(level, args, sharedContext);
  }

  _logEventually(level, args, context) {
    const log = this.makeLog(level, args, context);
    this._logBuffer.push(log);
  }

  _logImmediately(level, args, context = {}) {
    const log = this.makeLog(level, args, context);
    const payload = this.makePayload(log);
    return this._makeRequest(payload);
  }

  _scheduleLogWrite() {
    const {_pendingWrites, _lastWrittenAt} = this;
    if (_pendingWrites) return;

    const {bufferWriteInterval} = this.options;
    if (_lastWrittenAt + bufferWriteInterval < Date.now()) return;

    const write = this._nextWrite();
    if (!write) return;

    const {payload, remainingLogs} = write;
    return this._sendPayload(payload)
      .catch(error => {
        throw error;
      })
      .finally(() => {
        this._logBuffer = remainingLogs;
      });
  }

  _nextWrite() {
    const logs = this._logBuffer;
    const {bufferMaxPayloadSize} = this.options;
    if (!logs.length) return null;
    let bound = logs.length;
    let payload = {length: Infinity};
    while (payload.length > bufferMaxPayloadSize) {
      if (bound < 1) {
        this._logBuffer.shift(); // single log too large; prune it
        return this._nextWrite();
      }

      const pendingLogs = logs.slice(0, bound);
      payload = JSON.stringify(this.makePayload(pendingLogs));
      bound = Math.floor(bound / 2);
    }
    const remainingLogs = logs.slice(bound);
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
    const {requestUrl, requestTimeout} = this.options;
    return new Promise((resolve, reject) => {
      request
        .post(requestUrl)
        .send(payload)
        .timeout(requestTimeout)
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
