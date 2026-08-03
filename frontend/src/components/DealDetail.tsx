'use client';

import { useState } from 'react';

import { useWallet } from '@/context/WalletProvider';
import { useAction } from '@/hooks/useAction';
import { escrow } from '@/lib/contracts';
import { actionsFor, milestoneAmount, roleFor, waitingOn } from '@/lib/deal';
import { deadlineLabel, formatDate, formatXlm } from '@/lib/format';
import type { Deal, Milestone } from '@/lib/types';

import { AddressChip, Button, EmptyState, Skeleton, StatusPill } from './primitives';
import { ReputationChip } from './ReputationChip';
import { TxPipeline } from './TxPipeline';
import { ValueBar } from './ValueBar';

interface DealDetailProps {
  deal: Deal | null;
  milestones: Milestone[];
  loading: boolean;
  onReload: () => void;
  onBack: () => void;
}

export function DealDetail({ deal, milestones, loading, onReload, onBack }: DealDetailProps) {
  const { address } = useWallet();
  const { tx, run, busy } = useAction();

  if (!deal) {
    return loading ? (
      <div className="space-y-4 p-6">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    ) : (
      <EmptyState
        title="Select a deal"
        detail="Pick a deal from the list to see its milestones, its balance, and what it is waiting on."
      />
    );
  }

  const role = roleFor(deal, address);
  const actions = actionsFor(deal, milestones, role);

  const after = async () => {
    onReload();
  };

  const fund = () =>
    run({
      contract: 'escrow',
      success: 'Escrow funded',
      perform: (ctx) => escrow.fund(deal.address, ctx),
    }).then(after);

  const refund = () =>
    run({
      contract: 'escrow',
      success: 'Balance refunded',
      perform: (ctx) => escrow.refund(deal.address, ctx),
    }).then(after);

  const dispute = () =>
    run({
      contract: 'escrow',
      success: 'Dispute raised',
      perform: (ctx) => escrow.raiseDispute(deal.address, address!, ctx),
    }).then(after);

  const submit = (index: number, note: string) =>
    run({
      contract: 'escrow',
      success: `Milestone ${index + 1} submitted`,
      perform: (ctx) => escrow.submitMilestone(deal.address, index, note, ctx),
    }).then(after);

  const approve = (index: number) =>
    run({
      contract: 'escrow',
      success: `Milestone ${index + 1} approved`,
      perform: (ctx) => escrow.approveMilestone(deal.address, index, ctx),
    }).then(after);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="border-b border-line px-4 py-4 sm:px-6 sm:py-5">
        <button
          type="button"
          onClick={onBack}
          className="mb-3 text-xs font-semibold text-faint transition-colors hover:text-held lg:hidden"
        >
          ← All deals
        </button>

        <div className="flex items-start gap-3">
          <h1 className="min-w-0 flex-1 text-lg font-semibold tracking-tight text-text sm:text-xl">
            {deal.title}
          </h1>
          <StatusPill status={deal.status} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
          <AddressChip address={deal.client} label="client" />
          <AddressChip address={deal.worker} label="worker" />
          <AddressChip address={deal.address} kind="contract" label="escrow" />
        </div>
      </div>

      <div className="border-b border-line px-4 py-5 sm:px-6">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="tabular text-2xl font-semibold text-text sm:text-3xl">
            {formatXlm(deal.totalAmount)}
          </span>
          <span className="text-sm text-muted">XLM total</span>
          <span className="ml-auto text-xs text-muted">
            {deal.status === 'active' ? deadlineLabel(deal.deadline) : `due ${formatDate(deal.deadline)}`}
          </span>
        </div>

        <ValueBar
          total={deal.totalAmount}
          released={deal.released}
          milestoneCount={deal.milestoneCount}
          status={deal.status}
          size="lg"
          showLegend
        />

        <p className="mt-3 text-sm text-muted">{waitingOn(deal, actions, role)}</p>

        <div className="mt-3">
          <span className="eyebrow">Worker record</span>
          <div className="mt-1">
            <ReputationChip address={deal.worker} />
          </div>
        </div>

        {(actions.canFund || actions.canRefund || actions.canDispute) && (
          <div className="mt-4 flex flex-wrap gap-2">
            {actions.canFund && (
              <Button onClick={() => void fund()} disabled={busy}>
                Fund {formatXlm(deal.totalAmount, 2)} XLM
              </Button>
            )}
            {actions.canRefund && (
              <Button variant="danger" onClick={() => void refund()} disabled={busy}>
                Refund unreleased balance
              </Button>
            )}
            {actions.canDispute && (
              <Button variant="ghost" onClick={() => void dispute()} disabled={busy}>
                Raise dispute
              </Button>
            )}
          </div>
        )}

        {tx.stage !== 'idle' && (
          <div className="mt-4">
            <TxPipeline tx={tx} />
          </div>
        )}
      </div>

      <div className="px-4 py-4 sm:px-6">
        <h2 className="eyebrow mb-3">Milestones</h2>
        <ol className="space-y-px">
          {milestones.map((milestone) => (
            <li key={milestone.index}>
              <MilestoneRow
                deal={deal}
                milestone={milestone}
                canSubmit={actions.submittable.includes(milestone.index)}
                canApprove={actions.approvable.includes(milestone.index)}
                busy={busy}
                onSubmit={submit}
                onApprove={approve}
              />
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function MilestoneRow({
  deal,
  milestone,
  canSubmit,
  canApprove,
  busy,
  onSubmit,
  onApprove,
}: {
  deal: Deal;
  milestone: Milestone;
  canSubmit: boolean;
  canApprove: boolean;
  busy: boolean;
  onSubmit: (index: number, note: string) => void;
  onApprove: (index: number) => void;
}) {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);

  const amount = milestoneAmount(deal, milestone);
  const state = milestone.approved ? 'approved' : milestone.submitted ? 'submitted' : 'waiting';

  return (
    <div className="border-b border-line-soft py-3">
      <div className="flex items-start gap-3">
        <Marker index={milestone.index} state={state} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-semibold text-text">Milestone {milestone.index + 1}</span>
            <span
              className={`tabular text-sm ${milestone.approved ? 'text-paid' : 'text-muted'}`}
            >
              {formatXlm(amount)} XLM
            </span>
            {state === 'submitted' && (
              <span className="text-xs text-held">delivered, awaiting approval</span>
            )}
            {state === 'approved' && <span className="text-xs text-paid">paid</span>}
          </div>

          {milestone.note && (
            <p className="mt-1 text-sm text-muted wrap-break-word">{milestone.note}</p>
          )}

          {canApprove && (
            <Button
              className="mt-2 px-2.5 py-1.5 text-xs"
              onClick={() => onApprove(milestone.index)}
              disabled={busy}
            >
              Approve and release {formatXlm(amount, 2)} XLM
            </Button>
          )}

          {canSubmit && !open && (
            <Button
              variant="ghost"
              className="mt-2 px-2.5 py-1.5 text-xs"
              onClick={() => setOpen(true)}
            >
              Submit this milestone
            </Button>
          )}

          {canSubmit && open && (
            <form
              className="mt-2 space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                onSubmit(milestone.index, note.trim());
                setOpen(false);
                setNote('');
              }}
            >
              <label className="block">
                <span className="eyebrow">What you delivered</span>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={256}
                  rows={2}
                  required
                  autoFocus
                  placeholder="Wireframes and design system delivered"
                  className="mt-1 w-full resize-none rounded-xs border border-line bg-ink px-2.5 py-2 text-sm text-text placeholder:text-faint focus:border-held focus:outline-none"
                />
              </label>
              <div className="flex items-center gap-2">
                <Button type="submit" className="px-2.5 py-1.5 text-xs" disabled={busy}>
                  Submit
                </Button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="text-xs text-faint transition-colors hover:text-muted"
                >
                  Cancel
                </button>
                <span className="tabular ml-auto text-xs text-faint">{note.length}/256</span>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Milestones are an ordered sequence with money attached to each position, so
 * the number is information rather than ornament.
 */
function Marker({ index, state }: { index: number; state: 'waiting' | 'submitted' | 'approved' }) {
  const styles = {
    waiting: 'border-line text-faint',
    submitted: 'border-held text-held',
    approved: 'border-paid bg-paid/10 text-paid',
  }[state];

  return (
    <span
      aria-hidden
      className={`tabular mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-xs border text-xs font-semibold ${styles}`}
    >
      {state === 'approved' ? '✓' : index + 1}
    </span>
  );
}
