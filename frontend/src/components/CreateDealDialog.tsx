'use client';

import { useEffect, useState } from 'react';

import { useWallet } from '@/context/WalletProvider';
import { useAction } from '@/hooks/useAction';
import { registry } from '@/lib/contracts';
import {
  dateInputToUnix,
  defaultDeadlineDate,
  formatXlm,
  isAccountAddress,
  toStroops,
} from '@/lib/format';

import { Button } from './primitives';
import { TxPipeline } from './TxPipeline';

interface CreateDealDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (escrowAddress?: string) => void;
}

const MAX_MILESTONES = 10;

export function CreateDealDialog({ open, onClose, onCreated }: CreateDealDialogProps) {
  const { address, balance } = useWallet();
  const { tx, run, busy, reset } = useAction();

  const [worker, setWorker] = useState('');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [milestones, setMilestones] = useState(2);
  const [deadline, setDeadline] = useState(defaultDeadlineDate());
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, busy]);

  if (!open) return null;

  /** Everything the contract would reject, caught before a wallet prompt. */
  const validate = (): { stroops: bigint; deadlineUnix: number } | null => {
    if (!address) {
      setProblem('Connect a wallet first.');
      return null;
    }
    if (!isAccountAddress(worker)) {
      setProblem('Enter a valid Stellar account address for the worker (starts with G).');
      return null;
    }
    if (worker.trim() === address) {
      setProblem('The worker has to be someone other than you.');
      return null;
    }
    if (title.trim().length === 0 || title.trim().length > 128) {
      setProblem('Give the deal a title of 1 to 128 characters.');
      return null;
    }

    let stroops: bigint;
    try {
      stroops = toStroops(amount);
    } catch (error) {
      setProblem((error as Error).message);
      return null;
    }
    if (stroops < 10_000n) {
      setProblem('Deals must be worth at least 0.001 XLM.');
      return null;
    }
    if (balance !== null && stroops > balance) {
      setProblem(`That is more than your balance of ${formatXlm(balance, 2)} XLM.`);
      return null;
    }

    const deadlineUnix = dateInputToUnix(deadline);
    if (!Number.isFinite(deadlineUnix) || deadlineUnix <= Date.now() / 1000) {
      setProblem('Pick a deadline in the future.');
      return null;
    }

    setProblem(null);
    return { stroops, deadlineUnix };
  };

  const create = async () => {
    const valid = validate();
    if (!valid) return;

    const result = await run({
      contract: 'registry',
      success: 'Deal created',
      perform: (ctx) =>
        registry.createDeal(
          {
            client: address!,
            worker: worker.trim(),
            title: title.trim(),
            totalAmount: valid.stroops,
            milestoneCount: milestones,
            deadline: valid.deadlineUnix,
          },
          ctx,
        ),
    });

    if (result) {
      // The registry returns the address of the escrow it just deployed, so
      // the new deal can be opened immediately.
      const created = typeof result.returnValue === 'string' ? result.returnValue : undefined;
      onCreated(created);
      close();
    }
  };

  const close = () => {
    reset();
    setProblem(null);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/80 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-deal-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) close();
      }}
    >
      <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-sm border border-line bg-slate sm:rounded-sm">
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <h2 id="create-deal-title" className="text-base font-semibold tracking-tight">
            New deal
          </h2>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="ml-auto text-sm text-faint transition-colors hover:text-text disabled:opacity-40"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form
          className="space-y-4 px-5 py-5"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Field label="Worker address" hint="Who gets paid as milestones are approved.">
            <input
              value={worker}
              onChange={(event) => setWorker(event.target.value)}
              placeholder="G…"
              spellCheck={false}
              className="tabular w-full rounded-xs border border-line bg-ink px-3 py-2 text-sm text-text placeholder:text-faint focus:border-held focus:outline-none"
            />
          </Field>

          <Field label="What the work is">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={128}
              placeholder="Landing page redesign"
              className="w-full rounded-xs border border-line bg-ink px-3 py-2 text-sm text-text placeholder:text-faint focus:border-held focus:outline-none"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Total amount" hint="XLM, locked when you fund the escrow.">
              <input
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
                placeholder="30"
                className="tabular w-full rounded-xs border border-line bg-ink px-3 py-2 text-sm text-text placeholder:text-faint focus:border-held focus:outline-none"
              />
            </Field>

            <Field label="Deadline" hint="After this, you can reclaim what is unreleased.">
              <input
                type="date"
                value={deadline}
                onChange={(event) => setDeadline(event.target.value)}
                className="tabular w-full rounded-xs border border-line bg-ink px-3 py-2 text-sm text-text focus:border-held focus:outline-none"
              />
            </Field>
          </div>

          <Field label="Milestones" hint="The total splits evenly across them.">
            <div className="flex flex-wrap gap-1.5">
              {Array.from({ length: MAX_MILESTONES }, (_, i) => i + 1).map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => setMilestones(count)}
                  className={`tabular h-8 w-8 rounded-xs border text-sm transition-colors ${
                    milestones === count
                      ? 'border-held bg-held/10 text-held'
                      : 'border-line text-muted hover:border-held/40'
                  }`}
                >
                  {count}
                </button>
              ))}
            </div>
          </Field>

          {problem && (
            <p className="rounded-xs border border-risk/40 bg-risk/10 px-3 py-2 text-sm text-risk">
              {problem}
            </p>
          )}

          {tx.stage !== 'idle' && <TxPipeline tx={tx} />}

          <div className="flex items-center gap-2 pt-1">
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create deal'}
            </Button>
            <button
              type="button"
              onClick={close}
              disabled={busy}
              className="text-sm text-faint transition-colors hover:text-muted disabled:opacity-40"
            >
              Cancel
            </button>
          </div>

          <p className="text-xs text-faint">
            Creating a deal deploys a dedicated escrow contract. Funding it is a second, separate
            transaction.
          </p>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
    </label>
  );
}
