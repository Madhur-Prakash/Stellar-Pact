'use client';

import { useState } from 'react';

import { explorer } from '@/lib/config';
import { describeEvent, type EventTone } from '@/lib/events';
import { formatXlm, relativeTime, truncateAddress } from '@/lib/format';
import type { PactEvent } from '@/lib/types';

import { ExternalIcon } from './primitives';

const TONE_TEXT: Record<EventTone, string> = {
  held: 'text-held',
  paid: 'text-paid',
  risk: 'text-risk',
  neutral: 'text-muted',
};

const TONE_DOT: Record<EventTone, string> = {
  held: 'bg-held',
  paid: 'bg-paid',
  risk: 'bg-risk',
  neutral: 'bg-faint',
};

/**
 * The chain, as it happens.
 *
 * Sits along the bottom like a terminal tape rather than in a sidebar, because
 * it reports on the whole deployment, not on whichever deal is open. Collapsed
 * it shows the latest line; expanded it shows the run of history.
 */
export function ActivityTape({
  events,
  connected,
  ledger,
  onSelectContract,
}: {
  events: PactEvent[];
  connected: boolean;
  ledger: number | null;
  onSelectContract: (contractId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const latest = events[0];

  return (
    <div className="sticky bottom-0 z-20 border-t border-line bg-ink/95 backdrop-blur">
      {open && (
        <ul className="max-h-64 overflow-y-auto border-b border-line-soft">
          {events.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-faint">
              Nothing has happened on this deployment in the last few thousand ledgers.
            </li>
          ) : (
            events.map((event) => (
              <li key={event.id}>
                <EventRow event={event} onSelect={() => onSelectContract(event.contractId)} />
              </li>
            ))
          )}
        </ul>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-slate sm:px-6"
        aria-expanded={open}
      >
        <span className="flex shrink-0 items-center gap-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${connected ? 'pulse-dot bg-held' : 'bg-risk'}`}
            aria-hidden
          />
          <span className="eyebrow">{connected ? 'Live' : 'Reconnecting'}</span>
        </span>

        {ledger !== null && (
          <span className="tabular hidden shrink-0 text-xs text-faint sm:inline">
            ledger {ledger.toLocaleString('en-US')}
          </span>
        )}

        <span className="min-w-0 flex-1 truncate text-xs">
          {latest ? <TapeSummary event={latest} /> : <span className="text-faint">Waiting…</span>}
        </span>

        <span className="shrink-0 text-xs text-faint">{open ? 'Hide' : `Activity`}</span>
      </button>
    </div>
  );
}

function TapeSummary({ event }: { event: PactEvent }) {
  const summary = describeEvent(event);
  return (
    <span className={TONE_TEXT[summary.tone]}>
      {summary.label}
      {summary.amount !== undefined && (
        <span className="tabular ml-2 text-text">{formatXlm(summary.amount, 2)} XLM</span>
      )}
    </span>
  );
}

function EventRow({ event, onSelect }: { event: PactEvent; onSelect: () => void }) {
  const summary = describeEvent(event);
  const at = new Date(event.at).getTime() / 1000;

  return (
    <div className="tape-enter flex items-start gap-3 border-b border-line-soft px-4 py-2.5 sm:px-6">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[summary.tone]}`} aria-hidden />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <button
            type="button"
            onClick={onSelect}
            className={`text-sm font-semibold transition-opacity hover:opacity-75 ${TONE_TEXT[summary.tone]}`}
          >
            {summary.label}
          </button>
          {summary.amount !== undefined && (
            <span className="tabular text-sm text-text">{formatXlm(summary.amount, 2)} XLM</span>
          )}
          {summary.subject && (
            <span className="tabular text-xs text-faint">{truncateAddress(summary.subject)}</span>
          )}
        </div>
        {summary.note && <p className="mt-0.5 truncate text-xs text-muted">{summary.note}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-2 text-xs text-faint">
        <span>{relativeTime(at)}</span>
        {event.txHash && (
          <a
            href={explorer.tx(event.txHash)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="transition-colors hover:text-held"
            aria-label="View transaction"
          >
            <ExternalIcon />
          </a>
        )}
      </div>
    </div>
  );
}
