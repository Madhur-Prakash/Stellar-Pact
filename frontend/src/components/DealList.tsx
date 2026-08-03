'use client';

import { useMemo, useState } from 'react';

import { useWallet } from '@/context/WalletProvider';
import { roleFor } from '@/lib/deal';
import { deadlineLabel, formatXlm } from '@/lib/format';
import type { Deal } from '@/lib/types';

import { Button, EmptyState, Skeleton, StatusPill } from './primitives';
import { ValueBar } from './ValueBar';

type Filter = 'all' | 'client' | 'worker';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'client', label: 'Hiring' },
  { key: 'worker', label: 'Working' },
];

interface DealListProps {
  deals: Deal[];
  total: number;
  loading: boolean;
  selected: string | null;
  onSelect: (address: string) => void;
  onCreate: () => void;
}

export function DealList({
  deals,
  total,
  loading,
  selected,
  onSelect,
  onCreate,
}: DealListProps) {
  const { address, connecting, connect } = useWallet();
  const [filter, setFilter] = useState<Filter>('all');

  const visible = useMemo(() => {
    if (filter === 'all') return deals;
    return deals.filter((deal) => roleFor(deal, address) === filter);
  }, [deals, filter, address]);

  // Both role filters match on the connected address, so without one they can
  // only ever come back empty — which reads as "no deals" rather than "no
  // wallet". Tracked separately so the list can say which it is.
  const needsWallet = filter !== 'all' && !address;

  return (
    <section className="flex min-h-0 flex-1 flex-col border-line lg:border-r">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
        <h2 className="eyebrow">
          Deals{total > 0 && <span className="tabular ml-2 text-muted">{total}</span>}
        </h2>
        <div className="ml-auto flex items-center gap-1">
          {/* Hiring and Working stay clickable with no wallet connected. Greying
              them out states that they are unavailable but never why, and there
              is no hover tooltip on a touch screen — so let the click land and
              let the empty state name what is missing. */}
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`rounded-xs px-2 py-1 text-xs font-semibold transition-colors ${
                filter === key ? 'bg-panel text-held' : 'text-faint hover:text-muted'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <Button onClick={onCreate} className="px-2.5 py-1.5 text-xs">
          New deal
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && deals.length === 0 ? (
          <ul className="space-y-px">
            {[0, 1, 2].map((i) => (
              <li key={i} className="px-4 py-4 sm:px-5">
                <Skeleton className="mb-3 h-4 w-2/3" />
                <Skeleton className="h-1.5 w-full" />
              </li>
            ))}
          </ul>
        ) : needsWallet ? (
          <EmptyState
            title="Connect your wallet first"
            detail={`${
              filter === 'client' ? 'Hiring' : 'Working'
            } shows only the deals your address is party to, so it needs a connected wallet.`}
            action={
              <Button onClick={() => void connect()} disabled={connecting} className="mt-1">
                {connecting ? 'Connecting…' : 'Connect wallet'}
              </Button>
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title={filter === 'all' ? 'No deals yet' : 'Nothing here for this wallet'}
            detail={
              filter === 'all'
                ? 'Create a deal to lock XLM into an escrow that releases as work lands.'
                : 'Switch to All to see every deal on this deployment.'
            }
            action={
              filter === 'all' ? (
                <Button onClick={onCreate} className="mt-1">
                  Create a deal
                </Button>
              ) : null
            }
          />
        ) : (
          <ul>
            {visible.map((deal) => (
              <li key={deal.address}>
                <DealCard
                  deal={deal}
                  role={roleFor(deal, address)}
                  active={deal.address === selected}
                  onSelect={() => onSelect(deal.address)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function DealCard({
  deal,
  role,
  active,
  onSelect,
}: {
  deal: Deal;
  role: ReturnType<typeof roleFor>;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active}
      className={`w-full border-b border-line-soft px-4 py-4 text-left transition-colors sm:px-5 ${
        active ? 'bg-panel' : 'hover:bg-slate'
      }`}
    >
      <div className="mb-2 flex items-start gap-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">
          {deal.title}
        </span>
        <StatusPill status={deal.status} />
      </div>

      <ValueBar
        total={deal.totalAmount}
        released={deal.released}
        milestoneCount={deal.milestoneCount}
        status={deal.status}
      />

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className="text-text">
          <span className="tabular">{formatXlm(deal.totalAmount, 2)}</span> XLM
        </span>
        <span>
          {deal.approvedCount}/{deal.milestoneCount} milestones
        </span>
        {deal.status === 'active' && <span>{deadlineLabel(deal.deadline)}</span>}
        {role !== 'observer' && (
          <span className="ml-auto text-held">{role === 'client' ? 'You hired' : 'You work'}</span>
        )}
      </div>
    </button>
  );
}
