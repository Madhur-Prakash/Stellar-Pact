import { describe, expect, it } from 'vitest';

import { contractErrorCode, describeError } from './errors';

describe('contractErrorCode', () => {
  it('extracts the code the host reports', () => {
    expect(contractErrorCode('HostError: Error(Contract, #6)')).toBe(6);
    expect(contractErrorCode('Error(Contract,#10)')).toBe(10);
  });

  it('returns null when there is no contract error in the message', () => {
    expect(contractErrorCode('Error(WasmVm, InvalidAction)')).toBeNull();
    expect(contractErrorCode('network unreachable')).toBeNull();
  });
});

describe('describeError', () => {
  /**
   * The reason `describeError` takes a contract name: the same numeric code
   * means different things in different contracts, and guessing would tell the
   * user something confidently wrong.
   */
  it('reads the same code differently per contract', () => {
    const escrow = describeError(new Error('Error(Contract, #4)'), 'escrow');
    const reputation = describeError(new Error('Error(Contract, #4)'), 'reputation');

    expect(escrow.title).toBe('Not submitted yet');
    expect(reputation.title).toBe('Invalid amount');
    expect(escrow.title).not.toBe(reputation.title);
  });

  it('maps the escrow codes a user can actually hit', () => {
    expect(describeError(new Error('Error(Contract, #1)'), 'escrow').title).toBe(
      'Deal is not in that state',
    );
    expect(describeError(new Error('Error(Contract, #5)'), 'escrow').title).toBe(
      'Already approved',
    );
    expect(describeError(new Error('Error(Contract, #6)'), 'escrow').kind).toBe('contract');
    expect(describeError(new Error('Error(Contract, #7)'), 'escrow').kind).toBe('not-authorized');
  });

  it('maps registry validation codes', () => {
    expect(describeError(new Error('Error(Contract, #2)'), 'registry').title).toBe(
      'New deals are paused',
    );
    expect(describeError(new Error('Error(Contract, #3)'), 'registry').kind).toBe('validation');
    expect(describeError(new Error('Error(Contract, #6)'), 'registry').title).toBe(
      'Deadline already passed',
    );
  });

  it('names the forged-reputation rejection specifically', () => {
    const described = describeError(new Error('Error(Contract, #3)'), 'reputation');
    expect(described.kind).toBe('not-authorized');
    expect(described.title).toBe('Not a registered escrow');
  });

  it('still reports an unmapped code rather than swallowing it', () => {
    const described = describeError(new Error('Error(Contract, #99)'), 'escrow');
    expect(described.kind).toBe('contract');
    expect(described.detail).toContain('#99');
  });

  it('recognises a missing wallet', () => {
    expect(describeError(new Error('Freighter is not installed')).kind).toBe('wallet-missing');
    expect(describeError('no wallet available').kind).toBe('wallet-missing');
  });

  it('recognises a declined signature across wallet wordings', () => {
    for (const message of [
      'User rejected the request',
      'Request declined by user',
      'Action denied',
      'user closed the popup',
    ]) {
      expect(describeError(new Error(message)).kind, message).toBe('wallet-rejected');
    }
  });

  it('recognises an account that does not exist yet', () => {
    expect(describeError(new Error('Request failed with status 404')).kind).toBe(
      'account-unfunded',
    );
  });

  it('recognises an underfunded account', () => {
    expect(describeError(new Error('txINSUFFICIENT_BALANCE')).kind).toBe('insufficient-balance');
  });

  it('recognises transport failures', () => {
    for (const message of ['fetch failed', 'request timed out', 'NetworkError when attempting']) {
      expect(describeError(new Error(message)).kind, message).toBe('network');
    }
  });

  it('falls back to the raw message, bounded, when nothing matches', () => {
    const described = describeError(new Error('x'.repeat(500)));
    expect(described.kind).toBe('unknown');
    expect(described.detail.length).toBeLessThanOrEqual(180);
  });

  it('survives non-Error values', () => {
    expect(describeError(undefined).kind).toBe('unknown');
    expect(describeError({ weird: true }).kind).toBe('unknown');
  });

  it('always produces something showable', () => {
    for (const input of [new Error(''), '', null, 42]) {
      const described = describeError(input);
      expect(described.title.length).toBeGreaterThan(0);
      expect(described.detail.length).toBeGreaterThan(0);
    }
  });
});
