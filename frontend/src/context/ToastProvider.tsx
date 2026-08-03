'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ToastTone = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
  /** Renders an explorer link when the toast reports a settled transaction. */
  hash?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastState | null>(null);

/** Errors stay until dismissed; successes clear themselves. */
const LIFETIME_MS: Record<ToastTone, number | null> = {
  success: 9_000,
  info: 6_000,
  error: null,
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextId++;
      // Cap the stack so a burst of failures can't bury the page.
      setToasts((current) => [...current.slice(-3), { ...toast, id }]);

      const lifetime = LIFETIME_MS[toast.tone];
      if (lifetime) setTimeout(() => dismiss(id), lifetime);
    },
    [dismiss],
  );

  const value = useMemo<ToastState>(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastState {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
