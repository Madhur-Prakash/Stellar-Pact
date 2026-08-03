'use client';

import { useCallback, useEffect, useState } from 'react';

import { DEAL_POLL_MS } from '@/lib/config';
import { escrow, registry } from '@/lib/contracts';
import { describeError, type PactError } from '@/lib/errors';
import type { Deal, Milestone } from '@/lib/types';

/**
 * How many deals to hold on screen. Each one costs a simulation, so the list
 * reads the tail of the registry index — newest deals — rather than everything
 * ever created.
 */
const PAGE_SIZE = 18;

export function useDeals() {
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<PactError | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    // Scoped to this run of the effect, so a response that arrives after the
    // component unmounts or the poll restarts is dropped rather than applied.
    let current = true;

    const run = async () => {
      try {
        const count = await registry.totalDeals();
        if (!current) return;
        setTotal(count);

        if (count === 0) {
          setDeals([]);
          setError(null);
          return;
        }

        const start = Math.max(0, count - PAGE_SIZE);
        const addresses = await registry.escrows(start, PAGE_SIZE);
        const loaded = await Promise.all(
          addresses.map((address) => escrow.deal(address).catch(() => null)),
        );
        if (!current) return;

        // Newest first — the registry index is append-only.
        setDeals(loaded.filter((deal): deal is Deal => deal !== null).reverse());
        setError(null);
      } catch (cause) {
        if (current) setError(describeError(cause, 'registry'));
      }
    };

    void run();
    const timer = setInterval(() => void run(), DEAL_POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [nonce]);

  return {
    deals: deals ?? [],
    total,
    // Derived rather than stored: the list is loading exactly while it has
    // never resolved and has not errored.
    loading: deals === null && error === null,
    error,
    reload,
  };
}

interface LoadedDeal {
  address: string;
  deal: Deal;
  milestones: Milestone[];
}

export function useDeal(address: string | null) {
  const [loaded, setLoaded] = useState<LoadedDeal | null>(null);
  const [error, setError] = useState<PactError | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!address) return;
    let current = true;

    const run = async () => {
      try {
        const [deal, milestones] = await Promise.all([
          escrow.deal(address),
          escrow.milestones(address),
        ]);
        if (!current) return;
        setLoaded({ address, deal, milestones });
        setError(null);
      } catch (cause) {
        if (current) setError(describeError(cause, 'escrow'));
      }
    };

    void run();
    const timer = setInterval(() => void run(), DEAL_POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [address, nonce]);

  // Tagging the loaded value with its address means a response for a deal the
  // user has navigated away from can never be shown against the current one.
  const fresh = loaded && loaded.address === address ? loaded : null;

  return {
    deal: fresh?.deal ?? null,
    milestones: fresh?.milestones ?? [],
    loading: address !== null && fresh === null && error === null,
    error,
    reload,
  };
}
