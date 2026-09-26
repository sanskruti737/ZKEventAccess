/**
 * The logger is the only thing standing between a wallet failure and a user who
 * cannot diagnose it, so its own contract is tested rather than assumed.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { consoleLogger } from '../src/midnight/logger';

afterEach(() => vi.restoreAllMocks());

const capture = () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  return { info, warn, error, debug };
};

describe('consoleLogger', () => {
  it('"silent" actually silences info, instead of only promising to', () => {
    const { info, debug } = capture();
    const log = consoleLogger('silent');
    log.trace('t');
    log.debug('d');
    log.info('i');
    // The defect: `info` bypassed the level filter, so a caller asking for a
    // silent logger still shipped console output to every user.
    expect(info).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it('keeps warn and error unconditional, whatever the level', () => {
    const { warn, error } = capture();
    const log = consoleLogger('silent');
    log.warn('transaction rejected by the wallet');
    log.error('private state write was refused');
    // A log level must not be able to hide the two conditions a user has to be
    // able to diagnose after the fact.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('applies the threshold to info, and never to warn/error', () => {
    const { info, debug, warn, error } = capture();
    const log = consoleLogger('info');
    log.debug('below threshold');
    log.info('at threshold');
    log.warn('above');
    log.error('above');
    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('shows trace only when asked for trace', () => {
    const quiet = capture();
    consoleLogger('debug').trace('t');
    expect(quiet.debug).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    const loud = capture();
    consoleLogger('trace').trace('t');
    expect(loud.debug).toHaveBeenCalledTimes(1);
  });

  it('serialises bigint detail without throwing, since the ledger counter is a bigint', () => {
    const { info } = capture();
    expect(() => consoleLogger('info').info({ counter: 2n ** 64n - 1n })).not.toThrow();
    expect(info).toHaveBeenCalledTimes(1);
  });
});
