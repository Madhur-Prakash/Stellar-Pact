import { nativeToScVal } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { describeEvent, normalizeEvent } from './events';
import type { PactEvent, PactEventKind } from './types';

const WORKER = 'GCPCCXJGBEKDMWI5YOJJ7J6N3GFO4IHMXPBP33KQEIMYO3CFLWYWISDP';
const CLIENT = 'GC5TEJWFS4TA34JLS4EGVW2X2JHYPOKTD7VNW4CFHFPKHRY3TJHGTWFH';
const ESCROW = 'CC5BNJ4B5KBZGIBUGWNNSJHYCWBU63UODXUJDVPH2CBSC7FVMSVTZ6XH';

const symbol = (value: string) => nativeToScVal(value, { type: 'symbol' });
const address = (value: string) => nativeToScVal(value, { type: 'address' });

function rawEvent(topics: unknown[], value = nativeToScVal(0, { type: 'u32' })) {
  return {
    id: '0016896646155657216-0000000001',
    topic: topics,
    value,
    ledger: 3_934_057,
    ledgerClosedAt: '2026-08-02T17:00:02Z',
    contractId: { toString: () => ESCROW },
    txHash: '5304d3aec519b36fd596a38a6a7c1c5e7430a53966facd6ec7bec52071407e52',
  };
}

describe('normalizeEvent', () => {
  it('decodes a StellarPact event into its kind and indexed topics', () => {
    const event = normalizeEvent(
      rawEvent([symbol('pact'), symbol('approved'), address(WORKER), nativeToScVal(1, { type: 'u32' })]),
    );

    expect(event).not.toBeNull();
    expect(event?.kind).toBe('approved');
    expect(event?.contractId).toBe(ESCROW);
    expect(event?.ledger).toBe(3_934_057);
    // Topics after the `pact` prefix and the kind are the indexed fields.
    expect(event?.topics).toEqual([WORKER, 1]);
  });

  /**
   * The topic filter is server-side, but a shared RPC can still hand back other
   * contracts' events. Anything without the `pact` prefix is not ours.
   */
  it('drops events that are not StellarPact events', () => {
    expect(normalizeEvent(rawEvent([symbol('transfer'), address(WORKER)]))).toBeNull();
    expect(normalizeEvent(rawEvent([]))).toBeNull();
  });

  it('drops a pact event with no kind topic', () => {
    expect(normalizeEvent(rawEvent([symbol('pact')]))).toBeNull();
  });

  it('survives an undecodable payload rather than breaking the tape', () => {
    const event = normalizeEvent({
      ...rawEvent([symbol('pact'), symbol('funded')]),
      value: { nonsense: true } as never,
    });
    expect(event?.kind).toBe('funded');
    expect(event?.data).toEqual({});
  });
});

function pactEvent(
  kind: PactEventKind,
  topics: unknown[] = [],
  data: Record<string, unknown> = {},
): PactEvent {
  return {
    id: `id-${kind}`,
    kind,
    contractId: ESCROW,
    ledger: 1,
    at: '2026-08-02T17:00:02Z',
    topics,
    data,
  };
}

describe('describeEvent', () => {
  it('labels money moving into escrow as held', () => {
    const summary = describeEvent(pactEvent('funded', [CLIENT], { amount: 300_000_000n }));
    expect(summary.label).toBe('Escrow funded');
    expect(summary.tone).toBe('held');
    expect(summary.amount).toBe(300_000_000n);
    expect(summary.subject).toBe(CLIENT);
  });

  it('labels money reaching the worker as paid', () => {
    const summary = describeEvent(
      pactEvent('approved', [WORKER, 1], { amount: 150_000_000n, released: 300_000_000n }),
    );
    expect(summary.tone).toBe('paid');
    // Milestone indices are zero-based on-chain and one-based to a reader.
    expect(summary.label).toBe('Milestone 2 approved');
  });

  it('labels the paths where a deal went wrong as risk', () => {
    expect(describeEvent(pactEvent('refunded', [CLIENT], { refunded: 1n })).tone).toBe('risk');
    expect(describeEvent(pactEvent('disputed', [WORKER], { total_amount: 1n })).tone).toBe('risk');
  });

  it('reads the direction a dispute was settled', () => {
    expect(describeEvent(pactEvent('resolved', [WORKER], { paid_worker: true })).label).toMatch(
      /for worker/,
    );
    expect(describeEvent(pactEvent('resolved', [CLIENT], { paid_worker: false })).label).toMatch(
      /for client/,
    );
    expect(describeEvent(pactEvent('resolved', [CLIENT], { paid_worker: false })).tone).toBe(
      'risk',
    );
  });

  it('distinguishes a credited reputation from a failed one', () => {
    expect(describeEvent(pactEvent('recorded', [WORKER, ESCROW], { success: true })).tone).toBe(
      'paid',
    );
    expect(describeEvent(pactEvent('recorded', [WORKER, ESCROW], { success: false })).tone).toBe(
      'risk',
    );
  });

  it('carries the deal title through on creation', () => {
    const summary = describeEvent(
      pactEvent('created', [ESCROW, CLIENT], {
        title: 'Landing page redesign',
        total_amount: 300_000_000n,
      }),
    );
    expect(summary.note).toBe('Landing page redesign');
    expect(summary.amount).toBe(300_000_000n);
  });

  it('has a label for every event the contracts emit', () => {
    const kinds: PactEventKind[] = [
      'created',
      'funded',
      'submitted',
      'approved',
      'released',
      'refunded',
      'disputed',
      'resolved',
      'recorded',
      'paused',
      'wired',
      'wasm',
      'admin',
    ];

    for (const kind of kinds) {
      const summary = describeEvent(pactEvent(kind));
      expect(summary.label.length, kind).toBeGreaterThan(0);
      expect(summary.label, kind).not.toBe(kind);
    }
  });

  it('omits an amount for events where nothing moved', () => {
    expect(describeEvent(pactEvent('submitted', [WORKER, 0])).amount).toBeUndefined();
    expect(describeEvent(pactEvent('paused', [], { paused: true })).amount).toBeUndefined();
  });
});
