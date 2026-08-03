'use client';

import { useWallet } from '@/context/WalletProvider';
import { NETWORK } from '@/lib/config';
import { formatXlm, truncateAddress } from '@/lib/format';

import { Button, ExternalIcon, Skeleton } from './primitives';

export function Header() {
  const { address, connecting, balance, balanceLoading, connect, disconnect } = useWallet();

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ink/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Mark />
          <span className="truncate text-sm font-semibold tracking-tight">
            Stellar<span className="text-held">Pact</span>
          </span>
          <span className="eyebrow hidden shrink-0 sm:inline">{NETWORK}</span>
        </div>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {address && <Balance stroops={balance} loading={balanceLoading} />}

          {address ? (
            <div className="flex items-center gap-1.5 rounded-xs border border-line bg-slate px-2 py-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-held" aria-hidden />
              <span className="tabular text-xs text-text">{truncateAddress(address, 4, 4)}</span>
              <button
                type="button"
                onClick={() => void disconnect()}
                className="ml-1 text-xs font-semibold text-faint transition-colors hover:text-risk"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <Button onClick={() => void connect()} disabled={connecting}>
              {connecting ? 'Opening wallets…' : 'Connect wallet'}
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

function Balance({ stroops, loading }: { stroops: bigint | null; loading: boolean }) {
  if (loading && stroops === null) return <Skeleton className="h-7 w-24" />;

  // An account that does not exist yet is the normal state for a fresh testnet
  // wallet, so it gets a way forward rather than an error.
  if (stroops === null) {
    return (
      <a
        href={`https://friendbot.stellar.org`}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1.5 rounded-xs border border-risk/40 px-2 py-1.5 text-xs font-semibold text-risk transition-colors hover:bg-risk/10"
      >
        Not funded — get testnet XLM
        <ExternalIcon />
      </a>
    );
  }

  return (
    <div className="hidden items-baseline gap-1.5 rounded-xs border border-line bg-slate px-2.5 py-1.5 sm:flex">
      <span className="tabular text-sm text-text">{formatXlm(stroops, 2)}</span>
      <span className="text-xs text-faint">XLM</span>
    </div>
  );
}

/**
 * Two stacked bars: one filled, one hollow — value released above value still
 * held. The same idea the whole interface is built on, at 16 pixels.
 */
function Mark() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden>
      <rect x="1" y="3" width="14" height="4" rx="1" className="fill-paid" />
      <rect
        x="1.6"
        y="9.6"
        width="12.8"
        height="2.8"
        rx="0.6"
        className="fill-none stroke-held"
        strokeWidth="1.2"
      />
    </svg>
  );
}
