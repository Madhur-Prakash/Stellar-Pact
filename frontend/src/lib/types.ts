/**
 * Shapes the UI works in. Contract values arrive as snake_case maps with
 * bigints and raw enum ordinals; everything is normalised here once, at the
 * boundary, so no component ever deals with an ScVal or a `total_amount`.
 */

export type DealStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'refunded'
  | 'disputed';

/** Index matches the ordinal of `Status` in the escrow contract. */
export const DEAL_STATUSES: DealStatus[] = [
  'pending',
  'active',
  'completed',
  'refunded',
  'disputed',
];

export interface Deal {
  /** The escrow contract's own address — this is the deal's identity. */
  address: string;
  client: string;
  worker: string;
  token: string;
  reputation: string;
  registry: string;
  title: string;
  /** Stroops. */
  totalAmount: bigint;
  milestoneCount: number;
  approvedCount: number;
  /** Stroops already paid out. */
  released: bigint;
  /** Unix seconds. */
  deadline: number;
  status: DealStatus;
  createdAt: number;
}

export interface Milestone {
  index: number;
  /** Stroops. Zero until approval, when the exact share is known. */
  amount: bigint;
  submitted: boolean;
  approved: boolean;
  note: string;
  submittedAt: number;
  approvedAt: number;
}

export interface Reputation {
  completed: number;
  failed: number;
  totalEarned: bigint;
}

/** How the connected wallet relates to a given deal. */
export type Role = 'client' | 'worker' | 'observer';

/** The stages a write transaction moves through, in order. */
export type TxStage =
  | 'idle'
  | 'simulating'
  | 'signing'
  | 'submitting'
  | 'confirming'
  | 'success'
  | 'failed';

export interface TxState {
  stage: TxStage;
  hash?: string;
  error?: string;
}

/** Second topic of every StellarPact event, after the shared `pact` prefix. */
export type PactEventKind =
  | 'created'
  | 'funded'
  | 'submitted'
  | 'approved'
  | 'released'
  | 'refunded'
  | 'disputed'
  | 'resolved'
  | 'recorded'
  | 'paused'
  | 'wired'
  | 'wasm'
  | 'admin';

export interface PactEvent {
  id: string;
  kind: PactEventKind;
  /** The contract that emitted it — an escrow address for most kinds. */
  contractId: string;
  ledger: number;
  at: string;
  txHash?: string;
  /** Indexed topics after `pact` and the kind, already decoded. */
  topics: unknown[];
  data: Record<string, unknown>;
}
