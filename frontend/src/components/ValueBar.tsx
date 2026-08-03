import { formatXlm, percentOf } from '@/lib/format';
import type { DealStatus } from '@/lib/types';

interface ValueBarProps {
  total: bigint;
  released: bigint;
  milestoneCount: number;
  status: DealStatus;
  size?: 'sm' | 'lg';
  showLegend?: boolean;
}

/**
 * The deal, as a quantity.
 *
 * Gold is money that has reached the worker; ice is money still frozen in the
 * contract. Hairlines mark the milestone boundaries, so the bar shows the
 * payment schedule and the progress against it at the same time — the width of
 * each segment is literally what that milestone is worth.
 *
 * Before funding there is nothing to show but the schedule, and after a refund
 * the unreleased part went home rather than onward, so neither case is drawn
 * as held.
 */
export function ValueBar({
  total,
  released,
  milestoneCount,
  status,
  size = 'sm',
  showLegend = false,
}: ValueBarProps) {
  const paidPct = percentOf(released, total);
  const remainder = total - released;

  const holdsFunds = status === 'active' || status === 'disputed';
  const heldPct = holdsFunds ? Math.max(0, 100 - paidPct) : 0;

  const dividers = Array.from({ length: Math.max(0, milestoneCount - 1) }, (_, i) =>
    ((i + 1) / milestoneCount) * 100,
  );

  const height = size === 'lg' ? 'h-3' : 'h-1.5';

  return (
    <div>
      <div
        className={`relative w-full ${height} overflow-hidden rounded-xs bg-slate ring-1 ring-inset ring-line`}
        role="img"
        aria-label={`${formatXlm(released)} XLM released of ${formatXlm(total)} XLM across ${milestoneCount} milestones`}
      >
        <div
          className="bar-grow absolute inset-y-0 left-0 bg-paid"
          style={{ width: `${paidPct}%` }}
        />
        {heldPct > 0 && (
          <div
            className="bar-grow absolute inset-y-0 bg-held/45"
            style={{ left: `${paidPct}%`, width: `${heldPct}%` }}
          />
        )}
        {status === 'refunded' && (
          <div
            className="absolute inset-y-0 bg-risk/20"
            style={{ left: `${paidPct}%`, width: `${100 - paidPct}%` }}
          />
        )}

        {dividers.map((left) => (
          <span
            key={left}
            aria-hidden
            className="absolute inset-y-0 w-px bg-ink/70"
            style={{ left: `${left}%` }}
          />
        ))}
      </div>

      {showLegend && (
        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          <Legend swatch="bg-paid" label="released" value={released} />
          {holdsFunds && <Legend swatch="bg-held/45" label="held in escrow" value={remainder} />}
          {status === 'pending' && (
            <span className="text-muted">
              <span className="tabular text-text">{formatXlm(total)} XLM</span> to be funded
            </span>
          )}
          {status === 'refunded' && remainder > 0n && (
            <Legend swatch="bg-risk/50" label="returned to client" value={remainder} />
          )}
        </div>
      )}
    </div>
  );
}

function Legend({ swatch, label, value }: { swatch: string; label: string; value: bigint }) {
  return (
    <span className="flex items-center gap-2 text-muted">
      <span aria-hidden className={`h-2.5 w-2.5 rounded-[1px] ${swatch}`} />
      <span className="tabular text-text">{formatXlm(value)} XLM</span>
      {label}
    </span>
  );
}
