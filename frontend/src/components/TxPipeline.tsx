import { explorer } from '@/lib/config';
import type { TxState } from '@/lib/types';

import { ExternalIcon } from './primitives';

const STAGES = [
  { key: 'simulating', label: 'Simulate' },
  { key: 'signing', label: 'Sign' },
  { key: 'submitting', label: 'Submit' },
  { key: 'confirming', label: 'Confirm' },
] as const;

const ORDER: Record<string, number> = {
  idle: -1,
  simulating: 0,
  signing: 1,
  submitting: 2,
  confirming: 3,
  success: 4,
  failed: 4,
};

/**
 * Where the transaction actually is, rather than a spinner.
 *
 * Signing is the step that waits on a human, and simulate is the step that
 * usually fails, so naming them separately turns "it's stuck" into "your
 * wallet is waiting".
 */
export function TxPipeline({ tx }: { tx: TxState }) {
  if (tx.stage === 'idle') return null;

  const current = ORDER[tx.stage] ?? -1;
  const failed = tx.stage === 'failed';
  const done = tx.stage === 'success';

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xs border border-line bg-panel px-3 py-2">
      <div className="flex items-center gap-2">
        {STAGES.map((stage, index) => {
          const complete = index < current || done;
          const active = index === current && !done && !failed;
          const errored = failed && index === current;

          return (
            <div key={stage.key} className="flex items-center gap-2">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  errored
                    ? 'bg-risk'
                    : complete
                      ? 'bg-paid'
                      : active
                        ? 'pulse-dot bg-held'
                        : 'bg-line'
                }`}
                aria-hidden
              />
              <span
                className={`text-xs ${
                  errored ? 'text-risk' : complete ? 'text-muted' : active ? 'text-held' : 'text-faint'
                }`}
              >
                {stage.label}
              </span>
              {index < STAGES.length - 1 && <span className="h-px w-3 bg-line" aria-hidden />}
            </div>
          );
        })}
      </div>

      {done && <span className="text-xs font-semibold text-paid">Confirmed</span>}
      {failed && <span className="text-xs font-semibold text-risk">{tx.error ?? 'Failed'}</span>}

      {tx.hash && (
        <a
          href={explorer.tx(tx.hash)}
          target="_blank"
          rel="noreferrer"
          className="tabular ml-auto flex items-center gap-1 text-xs text-faint transition-colors hover:text-held"
        >
          {tx.hash.slice(0, 8)}…
          <ExternalIcon />
        </a>
      )}
    </div>
  );
}
