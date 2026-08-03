'use client';

import { useEffect, useState } from 'react';

import { reputation as reputationContract } from '@/lib/contracts';
import { formatXlm } from '@/lib/format';
import type { Reputation } from '@/lib/types';

/**
 * A worker's record, read straight from the reputation contract.
 *
 * "Unproven" and "untrustworthy" are different things, so a worker with no
 * history is never shown as 0% — they are shown as having no history.
 */
export function ReputationChip({ address }: { address: string }) {
  // Tagged with the address so switching deals shows nothing stale, without
  // needing to reset state on the way in.
  const [loaded, setLoaded] = useState<{ address: string; value: Reputation | null } | null>(null);

  useEffect(() => {
    let current = true;

    reputationContract
      .get(address)
      .then((value) => {
        if (current) setLoaded({ address, value });
      })
      .catch(() => {
        if (current) setLoaded({ address, value: null });
      });

    return () => {
      current = false;
    };
  }, [address]);

  const fresh = loaded && loaded.address === address ? loaded : null;

  if (!fresh) return <span className="text-xs text-faint">reading reputation…</span>;
  if (!fresh.value) return null;
  const record = fresh.value;

  const total = record.completed + record.failed;
  if (total === 0) {
    return <span className="text-xs text-faint">No completed deals yet</span>;
  }

  const rate = Math.round((record.completed / total) * 100);
  const clean = record.failed === 0;

  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
      <span className={`tabular font-semibold ${clean ? 'text-paid' : 'text-risk'}`}>{rate}%</span>
      <span>
        <span className="tabular text-text">{record.completed}</span> completed
        {record.failed > 0 && (
          <>
            , <span className="tabular text-risk">{record.failed}</span> failed
          </>
        )}
      </span>
      <span className="text-faint">
        · <span className="tabular">{formatXlm(record.totalEarned, 2)}</span> XLM earned
      </span>
    </span>
  );
}
