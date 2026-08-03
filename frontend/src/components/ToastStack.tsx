'use client';

import { useToast, type ToastTone } from '@/context/ToastProvider';
import { explorer } from '@/lib/config';

import { ExternalIcon } from './primitives';

const TONE: Record<ToastTone, { accent: string; text: string }> = {
  success: { accent: 'border-l-paid', text: 'text-paid' },
  error: { accent: 'border-l-risk', text: 'text-risk' },
  info: { accent: 'border-l-held', text: 'text-held' },
};

export function ToastStack() {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-3 top-16 z-50 flex flex-col gap-2 sm:inset-x-auto sm:right-6 sm:w-80"
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => {
        const tone = TONE[toast.tone];
        return (
          <div
            key={toast.id}
            className={`tape-enter pointer-events-auto rounded-xs border border-l-2 border-line bg-slate px-3 py-2.5 shadow-lg shadow-ink/50 ${tone.accent}`}
          >
            <div className="flex items-start gap-2">
              <p className={`flex-1 text-sm font-semibold ${tone.text}`}>{toast.title}</p>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="text-xs text-faint transition-colors hover:text-text"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>

            {toast.detail && <p className="mt-1 text-xs text-muted">{toast.detail}</p>}

            {toast.hash && (
              <a
                href={explorer.tx(toast.hash)}
                target="_blank"
                rel="noreferrer"
                className="tabular mt-1.5 inline-flex items-center gap-1 text-xs text-faint transition-colors hover:text-held"
              >
                {toast.hash.slice(0, 12)}…
                <ExternalIcon />
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
