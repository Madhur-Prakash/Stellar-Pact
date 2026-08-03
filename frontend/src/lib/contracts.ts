/**
 * Typed access to the three StellarPact contracts.
 *
 * Argument order here must match the Rust signatures exactly — Soroban passes
 * arguments positionally regardless of what they are named. The decoders below
 * are the only place snake_case contract fields exist.
 */

import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

import { REGISTRY_ID, REPUTATION_ID } from './config';
import { invokeContract, readContract, type SignTransaction } from './stellar';
import { DEAL_STATUSES, type Deal, type Milestone, type Reputation, type TxStage } from './types';

// ── Argument helpers ─────────────────────────────────────────────────────────

const addr = (value: string) => nativeToScVal(value, { type: 'address' });
const str = (value: string) => nativeToScVal(value, { type: 'string' });
const i128 = (value: bigint) => nativeToScVal(value, { type: 'i128' });
const u32 = (value: number) => nativeToScVal(value, { type: 'u32' });
const u64 = (value: number | bigint) => nativeToScVal(BigInt(value), { type: 'u64' });

// ── Decoders ─────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

/** Exported for testing — this mapping is where a contract change would bite. */
export function decodeDeal(address: string, raw: Raw): Deal {
  return {
    address,
    client: String(raw.client),
    worker: String(raw.worker),
    token: String(raw.token),
    reputation: String(raw.reputation),
    registry: String(raw.registry),
    title: String(raw.title),
    totalAmount: BigInt(raw.total_amount as bigint),
    milestoneCount: Number(raw.milestone_count),
    approvedCount: Number(raw.approved_count),
    released: BigInt(raw.released as bigint),
    deadline: Number(raw.deadline),
    status: DEAL_STATUSES[Number(raw.status)] ?? 'pending',
    createdAt: Number(raw.created_at),
  };
}

export function decodeMilestone(raw: Raw): Milestone {
  return {
    index: Number(raw.index),
    amount: BigInt(raw.amount as bigint),
    submitted: Boolean(raw.submitted),
    approved: Boolean(raw.approved),
    note: String(raw.note ?? ''),
    submittedAt: Number(raw.submitted_at),
    approvedAt: Number(raw.approved_at),
  };
}

export function decodeReputation(raw: Raw): Reputation {
  return {
    completed: Number(raw.completed),
    failed: Number(raw.failed),
    totalEarned: BigInt(raw.total_earned as bigint),
  };
}

// ── Shared write plumbing ────────────────────────────────────────────────────

export interface WriteContext {
  publicKey: string;
  sign: SignTransaction;
  onStage?: (stage: TxStage, hash?: string) => void;
}

function write(contractId: string, method: string, args: xdr.ScVal[], ctx: WriteContext) {
  return invokeContract({ contractId, method, args, ...ctx });
}

// ── Registry ─────────────────────────────────────────────────────────────────

export interface RegistryConfig {
  admin: string;
  reputation: string;
  token: string;
  paused: boolean;
  totalDeals: number;
}

export const registry = {
  async config(): Promise<RegistryConfig> {
    const raw = await readContract<Raw>(REGISTRY_ID, 'config');
    return {
      admin: String(raw.admin),
      reputation: String(raw.reputation),
      token: String(raw.token),
      paused: Boolean(raw.paused),
      totalDeals: Number(raw.total_deals),
    };
  },

  totalDeals: () => readContract<number>(REGISTRY_ID, 'total_deals'),

  isEscrow: (address: string) => readContract<boolean>(REGISTRY_ID, 'is_escrow', [addr(address)]),

  /** Newest deals sit at the end of the index, so callers page from the tail. */
  escrows: (start: number, limit: number) =>
    readContract<string[]>(REGISTRY_ID, 'get_escrows', [u32(start), u32(limit)]),

  createDeal(
    params: {
      client: string;
      worker: string;
      title: string;
      totalAmount: bigint;
      milestoneCount: number;
      deadline: number;
    },
    ctx: WriteContext,
  ) {
    return write(
      REGISTRY_ID,
      'create_deal',
      [
        addr(params.client),
        addr(params.worker),
        str(params.title),
        i128(params.totalAmount),
        u32(params.milestoneCount),
        u64(params.deadline),
      ],
      ctx,
    );
  },
};

// ── Escrow ───────────────────────────────────────────────────────────────────

export const escrow = {
  async deal(address: string): Promise<Deal> {
    return decodeDeal(address, await readContract<Raw>(address, 'get_deal'));
  },

  async milestones(address: string): Promise<Milestone[]> {
    const raw = await readContract<Raw[]>(address, 'get_milestones');
    return raw.map(decodeMilestone);
  },

  lockedAmount: (address: string) => readContract<bigint>(address, 'locked_amount'),

  fund: (address: string, ctx: WriteContext) => write(address, 'fund', [], ctx),

  submitMilestone: (address: string, index: number, note: string, ctx: WriteContext) =>
    write(address, 'submit_milestone', [u32(index), str(note)], ctx),

  approveMilestone: (address: string, index: number, ctx: WriteContext) =>
    write(address, 'approve_milestone', [u32(index)], ctx),

  refund: (address: string, ctx: WriteContext) => write(address, 'refund', [], ctx),

  raiseDispute: (address: string, by: string, ctx: WriteContext) =>
    write(address, 'raise_dispute', [addr(by)], ctx),

  resolveDispute: (address: string, payWorker: boolean, ctx: WriteContext) =>
    write(address, 'resolve_dispute', [nativeToScVal(payWorker)], ctx),
};

// ── Reputation ───────────────────────────────────────────────────────────────

export const reputation = {
  async get(who: string): Promise<Reputation> {
    return decodeReputation(await readContract<Raw>(REPUTATION_ID, 'get', [addr(who)]));
  },

  score: (who: string) => readContract<number>(REPUTATION_ID, 'score', [addr(who)]),
};
