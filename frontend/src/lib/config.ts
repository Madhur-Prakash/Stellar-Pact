/**
 * Every address the app uses comes from the environment, which
 * `scripts/deploy.sh` generates from `deployments/<network>.json`. Nothing is
 * hardcoded, so pointing the UI at a fresh deployment is a redeploy, not a
 * code change.
 */

export const NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet';

export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';

export const REGISTRY_ID = process.env.NEXT_PUBLIC_REGISTRY_ID ?? '';
export const REPUTATION_ID = process.env.NEXT_PUBLIC_REPUTATION_ID ?? '';
export const TOKEN_ID = process.env.NEXT_PUBLIC_TOKEN_ID ?? '';

/**
 * Endpoint defaults per network, so `NEXT_PUBLIC_RPC_URL` stays genuinely
 * optional. Hardcoding the testnet URLs here would mean a futurenet or mainnet
 * deployment silently read from testnet — the addresses would resolve to
 * nothing and the app would look broken rather than misconfigured.
 */
const ENDPOINTS: Record<string, { rpc: string; horizon: string }> = {
  testnet: {
    rpc: 'https://soroban-testnet.stellar.org',
    horizon: 'https://horizon-testnet.stellar.org',
  },
  futurenet: {
    rpc: 'https://rpc-futurenet.stellar.org',
    horizon: 'https://horizon-futurenet.stellar.org',
  },
  mainnet: {
    rpc: 'https://mainnet.sorobanrpc.com',
    horizon: 'https://horizon.stellar.org',
  },
  public: {
    rpc: 'https://mainnet.sorobanrpc.com',
    horizon: 'https://horizon.stellar.org',
  },
};

const endpoints = ENDPOINTS[NETWORK] ?? ENDPOINTS.testnet;

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? endpoints.rpc;

export const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL ?? endpoints.horizon;

/**
 * Missing configuration is a setup problem, not a runtime error — the app
 * reports it as a setup screen rather than failing on the first RPC call.
 */
export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!REGISTRY_ID) missing.push('NEXT_PUBLIC_REGISTRY_ID');
  if (!REPUTATION_ID) missing.push('NEXT_PUBLIC_REPUTATION_ID');
  if (!TOKEN_ID) missing.push('NEXT_PUBLIC_TOKEN_ID');
  return missing;
}

export const explorer = {
  tx: (hash: string) => `https://stellar.expert/explorer/${NETWORK}/tx/${hash}`,
  contract: (id: string) =>
    `https://stellar.expert/explorer/${NETWORK}/contract/${id}`,
  account: (id: string) =>
    `https://stellar.expert/explorer/${NETWORK}/account/${id}`,
};

/** How far back to look when the activity tape first loads. */
export const EVENT_LOOKBACK_LEDGERS = 8_000;
export const EVENT_POLL_MS = 6_000;
export const DEAL_POLL_MS = 15_000;
