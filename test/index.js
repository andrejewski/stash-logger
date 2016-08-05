/* eslint-env node, mocha */
import assert from 'assert';
import StashLogger from '..';

describe('StashLogger', () => {
  describe('constructor(parent, options)', () => {
    it('should not require a parent StashLogger', () => {
      const logger = new StashLogger();
      assert.ok(logger instanceof StashLogger);
    });
    it('should merge the options with the global defaults');
    it('should add methods defined by the logLevels option');
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
    it('should return a new StashLogger with merged options');
  });

  describe('<level>(messages...)', () => {
    it('should add messages to the log buffer');
    it('should add only messages above the StashLogger log level');
  });

  describe('<level>Immediately(messages...)', () => {
    it('should send messages immediately');
    it('should only send messages above the StashLogger log level');
  });

  it('should only make server requests through the root StashLogger');
  it('should only filter logs at the leaf StashLogger logLevel');
  it('should reduce the payload limit if the server says so');
  it('should try the request {bufferMaxWriteRetries} times');
  it('should send immediate logs even if the buffer write is pending');
});
