/* eslint-env node, mocha */
import assert from 'assert';
import StashLogger from '..';

describe('StashLogger', () => {
  describe('constructor(parent, options)', () => {
    it('should not require a parent StashLogger', () => {
      const logger = new StashLogger();
      assert.ok(logger instanceof StashLogger);
    });
    it('should merge the options with the class defaults', () => {
      class MyStashLogger extends StashLogger {
        defaults() {
          return Object.assign(super.defaults(), {cake: 'yes'});
        }
      }
      const logger = new MyStashLogger({rake: 'no'});
      assert.equal(logger.options.cake, 'yes');
      assert.equal(logger.options.rake, 'no');
    });
    it('should add methods defined by the logLevels option', () => {
      const logLevels = ['dev', 'test', 'stage', 'prod'];
      const logger = new StashLogger({logLevels});

      logLevels.forEach(level => {
        assert.equal(typeof logger[level], 'function');
        assert.equal(typeof logger[`${level}Immediately`], 'function');
      });
    });
  });

  describe('attach()', () => {
    it('should throw for non-root StashLoggers', () => {
      const parent = new StashLogger();
      const child = parent.extend();
      assert.throws(() => child.attach());
    });
  });

  describe('detach()', () => {
    it('should throw for non-root StashLoggers', () => {
      const parent = new StashLogger();
      const child = parent.extend();
      assert.throws(() => child.attach());
    });
  });

  describe('extend(options)', () => {
    it('should return a new StashLogger with merged options', () => {
      const parent = new StashLogger({cat: 1, dog: 2});
      const child = parent.extend({dog: 3});

      assert.equal(child.options.cat, 1);
      assert.equal(child.options.dog, 3);
    });
  });

  describe('<level>(messages...)', () => {
    it('should add messages to the log buffer', () => {
      const logger = new StashLogger();
      const message1 = 'log-test';
      const message2 = 'log-test';
      logger.log(message1);
      logger.error(message2);

      const buffer = logger.buffer();
      const log = buffer[0];
      assert.equal(buffer.length, 1);
      assert.equal(log.level, 'error');
      assert.deepEqual(JSON.parse(log.message).raw, [message2]);
    });
    it('should add only messages above the StashLogger log level', () => {
      const logger = new StashLogger({logLevel: 'info'});
      logger.log(0);
      logger.warn(1);
      logger.info(2);
      logger.log(3);
      logger.error(4);

      const buffer = logger.buffer();
      assert.equal(buffer.length, 3);
      assert.equal(buffer[0].level, 'warn');
      assert.equal(buffer[1].level, 'info');
      assert.equal(buffer[2].level, 'error');
    });
  });

  describe('<level>Immediately(messages...)', () => {
    it('should send logs immediately', () => {
      let makeRequestCalled = false;
      class MockStashLogger extends StashLogger {
        _makeRequest() {
          makeRequestCalled = true;
        }
      }
      const logger = new MockStashLogger();
      logger.errorImmediately('test');
      assert.equal(makeRequestCalled, true);
    });
    it('should only send logs above the StashLogger log level', () => {
      let makeRequestCalls = 0;
      class MockStashLogger extends StashLogger {
        _makeRequest() {
          makeRequestCalls++;
        }
      }
      const logger = new MockStashLogger({logLevel: 'info'});
      logger.logImmediately(0);
      logger.infoImmediately(1);
      logger.warnImmediately(2);
      logger.errorImmediately(3);
      assert.equal(makeRequestCalls, 3);
      logger.logImmediately(4);
      assert.equal(makeRequestCalls, 3);
    });
    it('should send logs even if the buffer write is pending', () => {
      let makeRequestCalls = 0;
      class MockStashLogger extends StashLogger {
        _makeRequest() {
          makeRequestCalls++;
        }
      }
      const logger = new MockStashLogger();
      logger._writePending = true;
      logger.errorImmediately(0);
      assert.equal(makeRequestCalls, 1);
    });
  });

  it('should only make server requests through the root StashLogger', () => {
    class MockStashLogger extends StashLogger {
      _makeRequest() {
        this.options.value++;
      }
    }

    const root = new MockStashLogger({value: 0});
    const brother = root.extend({value: 0});
    const sister = root.extend({value: 0});
    const grandson = brother.extend({value: 0});

    root.errorImmediately(0);
    root.error(1);

    brother.errorImmediately(0);
    brother.error(1);

    sister.errorImmediately(0);
    sister.error(1);

    grandson.errorImmediately(0);
    grandson.error(1);

    assert.equal(root.options.value, 4);
    assert.equal(root.buffer().length, 4);

    assert.equal(brother.options.value, 0);
    assert.equal(brother.buffer().length, 0);

    assert.equal(sister.options.value, 0);
    assert.equal(sister.buffer().length, 0);

    assert.equal(grandson.options.value, 0);
    assert.equal(grandson.buffer().length, 0);
  });

  it('should only filter logs at the local StashLogger logLevel', () => {
    const parent = new StashLogger({logLevel: 'log'});
    const child = parent.extend({logLevel: 'error'});
    const grandchild = child.extend({logLevel: 'info'});

    parent.log(0);
    child.log(1);
    grandchild.log(2);

    assert.equal(parent.buffer().length, 1);

    parent.info(0);
    child.info(1);
    grandchild.info(2);

    assert.equal(parent.buffer().length, 3);

    parent.error(0);
    child.error(1);
    grandchild.error(2);

    assert.equal(parent.buffer().length, 6);
  });

  it('should reduce the payload limit if the server says so');
  it('should try the request {bufferMaxWriteRetries} times');
});
