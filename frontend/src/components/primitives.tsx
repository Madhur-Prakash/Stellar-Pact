'use client';

import { useState, type ReactNode } from 'react';

import { explorer } from '@/lib/config';
import { truncateAddress } from '@/lib/format';
import type { DealStatus } from '@/lib/types';

/** A copyable address that links out to the explorer. */
export function AddressChip({
  address,
  kind = 'account',
  label,
}: {
  address: string;
  kind?: 'account' | 'contract';
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard is blocked in some contexts; the explorer link still works.
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      {label && <span className="text-muted">{label}</span>}
      <button
        type="button"
        onClick={copy}
        className="tabular rounded-xs px-1 py-0.5 text-text/90 transition-colors hover:bg-panel hover:text-held"
        title={copied ? 'Copied' : `Copy ${address}`}
      >
        {copied ? 'copied' : truncateAddress(address, 4, 4)}
      </button>
      <a
        href={kind === 'contract' ? explorer.contract(address) : explorer.account(address)}
        target="_blank"
        rel="noreferrer"
        className="text-faint transition-colors hover:text-held"
        title="View on Stellar Expert"
        aria-label={`View ${truncateAddress(address)} on Stellar Expert`}
      >
        <ExternalIcon />
      </a>
    </span>
  );
}

export function ExternalIcon({ className = 'h-3 w-3' }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" fill="none" className={className} aria-hidden>
      <path
        d="M4.5 2h5.5v5.5M10 2 5 7M8 8.5V10H2V4h1.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="square"
      />
    </svg>
  );
}

const STATUS_STYLES: Record<DealStatus, { label: string; className: string }> = {
  pending: { label: 'Awaiting funding', className: 'text-muted ring-line' },
  active: { label: 'Active', className: 'text-held ring-held/40' },
  completed: { label: 'Completed', className: 'text-paid ring-paid/40' },
  refunded: { label: 'Refunded', className: 'text-risk ring-risk/40' },
  disputed: { label: 'Disputed', className: 'text-risk ring-risk/50' },
};

export function StatusPill({ status }: { status: DealStatus }) {
  const { label, className } = STATUS_STYLES[status];
  return (
    <span
      className={`inline-flex items-center rounded-xs px-1.5 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] ring-1 ring-inset ${className}`}
    >
      {label}
    </span>
  );
}

export function Panel({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-sm border border-line bg-slate ${className}`}>{children}</div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-xs bg-panel ${className}`} aria-hidden />;
}

/** An empty screen is an invitation to act, so it always names the next step. */
export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="text-sm font-semibold text-text">{title}</p>
      <p className="max-w-sm text-sm text-muted">{detail}</p>
      {action}
    </div>
  );
}

type ButtonVariant = 'primary' | 'ghost' | 'danger';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-held text-ink hover:bg-held/85 disabled:bg-held/30 disabled:text-ink/50',
  ghost: 'border border-line text-text hover:border-held/50 hover:text-held disabled:text-faint',
  danger: 'border border-risk/40 text-risk hover:bg-risk/10 disabled:text-risk/40',
};

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-xs px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${BUTTON_STYLES[variant]} ${className}`}
    />
  );
}
