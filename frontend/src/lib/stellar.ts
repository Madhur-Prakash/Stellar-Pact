/**
 * The transport layer: one place that knows how to read from a contract, how
 * to get a write signed and confirmed, and how to look up an XLM balance.
 *
 * Reads are simulations against a null source account, so they cost nothing and
 * need no wallet. Writes go through the full pipeline — simulate, assemble the
 * authorization tree, sign, submit, poll — reporting each stage so the UI can
 * show where a transaction actually is rather than a generic spinner.
 */

import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  contract as contractNs,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

import { HORIZON_URL, NETWORK_PASSPHRASE, RPC_URL } from './config';
import { toStroops } from './format';
import type { TxStage } from './types';

/**
 * Ten times the base fee. `assembleTransaction` adds the resource fee on top;
 * this is only the inclusion bid, and paying a little over the minimum keeps
 * transactions from being dropped when testnet is busy.
 */
const INCLUSION_FEE = String(Number(BASE_FEE) * 10);

let cached: rpc.Server | null = null;

export function getServer(): rpc.Server {
  if (!cached) {
    cached = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') });
  }
  return cached;
}

export interface SignResult {
  signedTxXdr: string;
}

export type SignTransaction = (
  xdr: string,
  opts: { networkPassphrase: string; address: string },
) => Promise<SignResult>;

/**
 * Read a contract value. Simulation only — never submitted, never signed.
 */
export async function readContract<T>(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<T> {
  const server = getServer();
  const source = new Account(contractNs.NULL_ACCOUNT, '0');

  const tx = new TransactionBuilder(source, {
    fee: INCLUSION_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }
  if (!sim.result?.retval) {
    throw new Error(`${method} returned no value`);
  }
  return scValToNative(sim.result.retval) as T;
}

export interface InvokeParams {
  contractId: string;
  method: string;
  args?: xdr.ScVal[];
  publicKey: string;
  sign: SignTransaction;
  onStage?: (stage: TxStage, hash?: string) => void;
}

export interface InvokeResult {
  hash: string;
  returnValue: unknown;
}

/**
 * Run a state-changing contract call end to end.
 *
 * Simulation is what produces the authorization entries — for calls like
 * `fund`, which makes the token contract move the client's XLM, the wallet is
 * signing a nested authorization tree rather than a single flat invocation.
 * `assembleTransaction` attaches that tree along with the resource footprint.
 */
export async function invokeContract({
  contractId,
  method,
  args = [],
  publicKey,
  sign,
  onStage,
}: InvokeParams): Promise<InvokeResult> {
  const server = getServer();

  onStage?.('simulating');
  const account = await server.getAccount(publicKey);
  const built = new TransactionBuilder(account, {
    fee: INCLUSION_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(180)
    .build();

  const sim = await server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }
  const prepared = rpc.assembleTransaction(built, sim).build();

  onStage?.('signing');
  const { signedTxXdr } = await sign(prepared.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: publicKey,
  });

  onStage?.('submitting');
  const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
  const sent = await server.sendTransaction(signed);

  if (sent.status === 'ERROR') {
    throw new Error(
      `The network rejected the transaction: ${JSON.stringify(sent.errorResult ?? sent.status)}`,
    );
  }

  onStage?.('confirming', sent.hash);
  const settled = await waitForTransaction(sent.hash);

  if (settled.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    onStage?.('failed', sent.hash);
    throw new Error(
      `Transaction ${sent.hash} failed on-chain: ${JSON.stringify(
        (settled as { resultXdr?: unknown }).resultXdr ?? settled.status,
      )}`,
    );
  }

  onStage?.('success', sent.hash);
  return {
    hash: sent.hash,
    returnValue: settled.returnValue ? scValToNative(settled.returnValue) : undefined,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the ledger closes. Backs off gently rather than hammering the RPC:
 * ledgers close every ~5s, so a tight loop would just burn requests.
 */
async function waitForTransaction(hash: string, timeoutMs = 60_000) {
  const server = getServer();
  const deadline = Date.now() + timeoutMs;
  let wait = 800;

  while (Date.now() < deadline) {
    const result = await server.getTransaction(hash);
    if (result.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return result;
    }
    await sleep(wait);
    wait = Math.min(wait * 1.4, 3_000);
  }

  throw new Error(
    `Timed out waiting for ${hash} to confirm. It may still succeed — check the explorer.`,
  );
}

/**
 * Native XLM balance in stroops, or `null` when the account does not exist yet.
 * A missing account is a normal state for a fresh testnet wallet, not an error.
 */
export async function fetchXlmBalance(publicKey: string): Promise<bigint | null> {
  const response = await fetch(`${HORIZON_URL}/accounts/${publicKey}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Horizon returned ${response.status} for ${publicKey}`);
  }

  const account = (await response.json()) as {
    balances?: Array<{ asset_type: string; balance: string }>;
  };
  const native = account.balances?.find((b) => b.asset_type === 'native');
  return native ? toStroops(native.balance) : 0n;
}

export async function latestLedger(): Promise<number> {
  const { sequence } = await getServer().getLatestLedger();
  return sequence;
}
