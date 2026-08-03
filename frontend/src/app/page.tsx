'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useState } from 'react';

import { ActivityTape } from '@/components/ActivityTape';
import { CreateDealDialog } from '@/components/CreateDealDialog';
import { DealDetail } from '@/components/DealDetail';
import { DealList } from '@/components/DealList';
import { Header } from '@/components/Header';
import { Overview } from '@/components/Overview';
import { SetupNotice } from '@/components/SetupNotice';
import { ToastStack } from '@/components/ToastStack';
import { useDeal, useDeals } from '@/hooks/useDeals';
import { useEventTape } from '@/hooks/useEventTape';
import { missingConfig } from '@/lib/config';

export default function Page() {
  const missing = missingConfig();
  if (missing.length > 0) return <SetupNotice missing={missing} />;

  // useSearchParams needs a boundary; the shell renders instantly either way.
  return (
    <Suspense fallback={<Header />}>
      <Dashboard />
    </Suspense>
  );
}

function Dashboard() {
  const searchParams = useSearchParams();
  // Deal links are shareable, so the URL seeds the selection. After that the
  // URL is kept in step with history.replaceState — updating the selection is
  // not a navigation.
  const [selected, setSelected] = useState<string | null>(() => searchParams.get('deal'));

  const { deals, total, loading, reload } = useDeals();
  const { deal, milestones, loading: dealLoading, reload: reloadDeal } = useDeal(selected);
  const { events, connected, ledger } = useEventTape();
  const [creating, setCreating] = useState(false);

  const select = useCallback((address: string | null) => {
    setSelected(address);
    const url = new URL(window.location.href);
    if (address) url.searchParams.set('deal', address);
    else url.searchParams.delete('deal');
    window.history.replaceState(null, '', url);
  }, []);

  const onCreated = useCallback(
    (escrowAddress?: string) => {
      void reload();
      if (escrowAddress) select(escrowAddress);
    },
    [reload, select],
  );

  // Clicking through from the tape only makes sense for events that came from
  // an escrow — registry and reputation events have no detail view.
  const openFromTape = useCallback(
    (contractId: string) => {
      if (deals.some((candidate) => candidate.address === contractId)) select(contractId);
    },
    [deals, select],
  );

  return (
    <>
      <Header />

      <main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        <div className={`min-h-0 flex-col ${selected ? 'hidden lg:flex' : 'flex'}`}>
          <DealList
            deals={deals}
            total={total}
            loading={loading}
            selected={selected}
            onSelect={select}
            onCreate={() => setCreating(true)}
          />
        </div>

        <div className={`min-h-0 flex-col ${selected ? 'flex' : 'hidden lg:flex'}`}>
          {selected ? (
            <DealDetail
              deal={deal}
              milestones={milestones}
              loading={dealLoading}
              onReload={() => {
                void reloadDeal();
                void reload();
              }}
              onBack={() => select(null)}
            />
          ) : (
            <Overview dealCount={total} />
          )}
        </div>
      </main>

      <ActivityTape
        events={events}
        connected={connected}
        ledger={ledger}
        onSelectContract={openFromTape}
      />

      <CreateDealDialog open={creating} onClose={() => setCreating(false)} onCreated={onCreated} />
      <ToastStack />
    </>
  );
}
