import { describe, expect, it } from 'vitest';

import { HORIZON_URL, NETWORK, NETWORK_PASSPHRASE, RPC_URL, missingConfig } from './config';

describe('config', () => {
  it('resolves every address the app needs', () => {
    expect(missingConfig()).toEqual([]);
  });

  /**
   * The passphrase contains a semicolon. Some .env parsers treat `;` as a
   * comment delimiter, which would truncate it to "Test SDF Network" — and a
   * truncated passphrase produces signatures the network rejects, on every
   * single transaction. Cheap to assert, expensive to debug.
   */
  it('carries the full network passphrase, semicolon included', () => {
    expect(NETWORK_PASSPHRASE).toBe('Test SDF Network ; September 2015');
    expect(NETWORK_PASSPHRASE).toContain(';');
  });

  it('points at endpoints belonging to the configured network', () => {
    expect(NETWORK).toBe('testnet');
    expect(RPC_URL).toMatch(/^https:\/\//);
    expect(HORIZON_URL).toMatch(/^https:\/\//);
    // Whichever network is configured, the endpoints must match it — a testnet
    // build reading mainnet Horizon would resolve nothing and look broken.
    expect(RPC_URL).toContain('testnet');
    expect(HORIZON_URL).toContain('testnet');
  });
});
