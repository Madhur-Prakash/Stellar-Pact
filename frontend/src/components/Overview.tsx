'use client';

import { useEffect, useState } from 'react';

import { REGISTRY_ID, REPUTATION_ID, TOKEN_ID } from '@/lib/config';
import { registry, type RegistryConfig } from '@/lib/contracts';

import { AddressChip } from './primitives';

/**
 * What fills the detail pane before a deal is picked.
 *
 * The interesting claim StellarPact makes is structural — three contracts, one
 * escrow per deal, reputation nobody can forge — so the resting state of the
 * app states it plainly and links to the contracts so it can be checked.
 */
export function Overview({ dealCount }: { dealCount: number }) {
  const [config, setConfig] = useState<RegistryConfig | null>(null);

  useEffect(() => {
    let current = true;
    registry
      .config()
      .then((next) => {
        if (current) setConfig(next);
      })
      .catch(() => {
        // The setup screen already covers a misconfigured deployment; a failed
        // read here just means this panel stays quiet.
      });
    return () => {
      current = false;
    };
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-5 py-10 sm:px-8 sm:py-14">
      <h1 className="text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
        Money held by a contract,
        <br />
        <span className="text-muted">released as the work lands.</span>
      </h1>

      <p className="mt-4 max-w-prose text-sm leading-relaxed text-muted">
        A client locks XLM into an escrow that exists for one deal and nothing else. Each approved
        milestone releases its share to the worker. When the last one clears, the escrow writes a
        reputation record that the worker could not have written themselves.
      </p>

      <div className="mt-8">
        <span className="eyebrow">How a deal moves</span>
        <ol className="mt-3 space-y-2.5">
          <Step n={1} tone="text-muted">
            The registry <em className="not-italic text-text">deploys a new escrow contract</em> for
            the deal — a contract deploying a contract.
          </Step>
          <Step n={2} tone="text-held">
            The client funds it. XLM moves through the native asset contract and is{' '}
            <em className="not-italic text-held">held</em>.
          </Step>
          <Step n={3} tone="text-paid">
            Each approval <em className="not-italic text-paid">releases</em>{' '}
            that milestone&apos;s share to the worker.
          </Step>
          <Step n={4} tone="text-muted">
            On the final approval the escrow writes reputation, which calls back into the registry
            to verify the escrow is real.
          </Step>
        </ol>
      </div>

      <div className="mt-8 grid gap-px overflow-hidden rounded-sm border border-line bg-line sm:grid-cols-3">
        <Stat label="Deals created" value={String(config?.totalDeals ?? dealCount)} />
        <Stat label="New deals" value={config ? (config.paused ? 'Paused' : 'Open') : '—'} />
        <Stat label="Settled in" value="XLM" />
      </div>

      <div className="mt-6 space-y-2 text-xs">
        <span className="eyebrow">Deployed contracts</span>
        <div className="flex flex-col gap-1.5 pt-1">
          <AddressChip address={REGISTRY_ID} kind="contract" label="registry" />
          <AddressChip address={REPUTATION_ID} kind="contract" label="reputation" />
          <AddressChip address={TOKEN_ID} kind="contract" label="XLM asset contract" />
        </div>
      </div>
    </div>
  );
}

function Step({ n, tone, children }: { n: number; tone: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 text-sm leading-relaxed">
      <span className={`tabular shrink-0 pt-px text-xs font-semibold ${tone}`}>{n}</span>
      <span className="text-muted">{children}</span>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate px-4 py-3">
      <div className="tabular text-lg font-semibold text-text">{value}</div>
      <div className="eyebrow mt-0.5">{label}</div>
    </div>
  );
}
