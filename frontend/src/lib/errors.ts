/**
 * Turns whatever the wallet, the RPC or a contract threw into something a
 * person can act on.
 *
 * Contract errors arrive as `Error(Contract, #N)` where N is only meaningful
 * alongside the contract that produced it — code 4 is "not submitted" in the
 * escrow and "invalid amount" in reputation. Callers therefore say which
 * contract they were talking to, and the tables below do the rest.
 */

export type PactErrorKind =
  | 'wallet-missing'
  | 'wallet-rejected'
  | 'account-unfunded'
  | 'insufficient-balance'
  | 'not-authorized'
  | 'contract'
  | 'network'
  | 'config'
  | 'validation'
  | 'unknown';

export interface PactError {
  kind: PactErrorKind;
  /** Short, states what happened. */
  title: string;
  /** One sentence on what to do about it. */
  detail: string;
}

export type ContractName = 'registry' | 'escrow' | 'reputation';

const REGISTRY_ERRORS: Record<number, PactError> = {
  1: { kind: 'not-authorized', title: 'Not authorized', detail: 'Only the registry admin can do that.' },
  2: { kind: 'contract', title: 'New deals are paused', detail: 'The admin has paused deal creation. Existing deals still work.' },
  3: { kind: 'validation', title: 'Client and worker match', detail: 'Enter a worker address different from your own.' },
  4: { kind: 'validation', title: 'Amount out of range', detail: 'Deals must be worth at least 0.001 XLM.' },
  5: { kind: 'validation', title: 'Milestone count out of range', detail: 'Choose between 1 and 10 milestones.' },
  6: { kind: 'validation', title: 'Deadline already passed', detail: 'Pick a deadline in the future.' },
  7: { kind: 'validation', title: 'Title out of range', detail: 'Give the deal a title of 1 to 128 characters.' },
  8: { kind: 'validation', title: 'Page out of range', detail: 'That page is past the end of the deal list.' },
};

const ESCROW_ERRORS: Record<number, PactError> = {
  1: { kind: 'contract', title: 'Deal is not in that state', detail: 'Someone changed the deal since this page loaded. Refresh to see where it stands.' },
  2: { kind: 'validation', title: 'No such milestone', detail: 'That milestone does not exist on this deal.' },
  3: { kind: 'contract', title: 'Already submitted', detail: 'This milestone is waiting on the client to approve it.' },
  4: { kind: 'contract', title: 'Not submitted yet', detail: 'The worker has to submit this milestone before it can be approved.' },
  5: { kind: 'contract', title: 'Already approved', detail: 'This milestone has been paid out.' },
  6: { kind: 'contract', title: 'Deadline has not passed', detail: 'A refund is only possible once the deadline is behind you.' },
  7: { kind: 'not-authorized', title: 'Not part of this deal', detail: 'Only the client or the worker can raise a dispute.' },
  8: { kind: 'not-authorized', title: 'Not authorized', detail: 'Your wallet is not permitted to take this action.' },
  9: { kind: 'validation', title: 'Note too long', detail: 'Keep the submission note under 256 characters.' },
  10: { kind: 'contract', title: 'Nothing left to settle', detail: 'Every milestone on this deal has already been paid.' },
};

const REPUTATION_ERRORS: Record<number, PactError> = {
  1: { kind: 'contract', title: 'Already wired', detail: 'The reputation contract is already pointed at a registry.' },
  2: { kind: 'config', title: 'Reputation is not wired', detail: 'Run scripts/deploy.sh to finish wiring the deployment.' },
  3: { kind: 'not-authorized', title: 'Not a registered escrow', detail: 'Only escrows the registry deployed can write reputation.' },
  4: { kind: 'validation', title: 'Invalid amount', detail: 'Payout amounts cannot be negative.' },
};

const TABLES: Record<ContractName, Record<number, PactError>> = {
  registry: REGISTRY_ERRORS,
  escrow: ESCROW_ERRORS,
  reputation: REPUTATION_ERRORS,
};

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return `${error.message} ${String(error.cause ?? '')}`;
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/** Pull the numeric code out of `Error(Contract, #7)`. */
export function contractErrorCode(message: string): number | null {
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(message);
  return match ? Number(match[1]) : null;
}

export function describeError(error: unknown, contract?: ContractName): PactError {
  const message = messageOf(error);

  // Contract errors are the most specific thing we can say, so check first.
  const code = contractErrorCode(message);
  if (code !== null) {
    const known = contract && TABLES[contract][code];
    if (known) return known;
    return {
      kind: 'contract',
      title: 'The contract rejected this',
      detail: `The transaction failed with contract error #${code}.`,
    };
  }

  if (/not (installed|available|found)|no wallet|isConnected|is not defined|undefined window/i.test(message)) {
    return {
      kind: 'wallet-missing',
      title: 'Wallet not detected',
      detail: 'Install the wallet extension, unlock it, then connect again.',
    };
  }

  if (/reject|declin|denied|cancel|user (closed|dismissed)/i.test(message)) {
    return {
      kind: 'wallet-rejected',
      title: 'Signature declined',
      detail: 'Nothing was submitted. Approve the request in your wallet to continue.',
    };
  }

  if (/404|account not found|NotFoundError|resource missing/i.test(message)) {
    return {
      kind: 'account-unfunded',
      title: 'Account not funded',
      detail: 'This account does not exist on the network yet. Fund it from friendbot first.',
    };
  }

  if (/insufficient|underfunded|balance is not sufficient|txINSUFFICIENT/i.test(message)) {
    return {
      kind: 'insufficient-balance',
      title: 'Not enough XLM',
      detail: 'Your balance will not cover this amount plus the network fee.',
    };
  }

  if (/unauthorized|auth.*(fail|invalid|missing)|InvalidAction/i.test(message)) {
    return {
      kind: 'not-authorized',
      title: 'Not authorized',
      detail: 'Your wallet is not permitted to take this action on this deal.',
    };
  }

  if (/timeout|timed out|fetch failed|Failed to fetch|NetworkError|ECONN|502|503|504/i.test(message)) {
    return {
      kind: 'network',
      title: 'Network did not respond',
      detail: 'The Soroban RPC is unreachable or slow. Try again in a moment.',
    };
  }

  return {
    kind: 'unknown',
    title: 'Transaction failed',
    detail: message.slice(0, 180) || 'No further detail was returned.',
  };
}
