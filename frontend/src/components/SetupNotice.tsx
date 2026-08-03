/**
 * Shown when the deployment addresses are missing. This is a setup problem with
 * a known fix, so it says the fix rather than reporting a failure.
 */
export function SetupNotice({ missing }: { missing: string[] }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-lg rounded-sm border border-line bg-slate p-6">
        <span className="eyebrow">Setup needed</span>
        <h1 className="mt-2 text-lg font-semibold tracking-tight">
          StellarPact does not know where its contracts are.
        </h1>

        <p className="mt-3 text-sm text-muted">
          Deploy the contracts and the script writes the addresses for you:
        </p>

        <pre className="tabular mt-3 overflow-x-auto rounded-xs border border-line bg-ink px-3 py-2.5 text-xs text-held">
          bash scripts/deploy.sh
        </pre>

        <p className="mt-4 text-sm text-muted">
          That generates <code className="tabular text-text">frontend/.env.local</code>. These
          entries are still missing:
        </p>

        <ul className="mt-2 space-y-1">
          {missing.map((key) => (
            <li key={key} className="tabular text-sm text-risk">
              {key}
            </li>
          ))}
        </ul>

        <p className="mt-4 text-xs text-faint">
          Deploying to a host? Copy the same values into the project&apos;s environment variables —
          they are read at build time.
        </p>
      </div>
    </main>
  );
}
