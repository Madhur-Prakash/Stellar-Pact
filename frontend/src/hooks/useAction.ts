'use client';

import { useCallback, useState } from 'react';

import { useToast } from '@/context/ToastProvider';
import { useWallet } from '@/context/WalletProvider';
import type { WriteContext } from '@/lib/contracts';
import { describeError, type ContractName } from '@/lib/errors';
import type { InvokeResult } from '@/lib/stellar';
import type { TxState } from '@/lib/types';

/**
 * One place every write goes through, so each of them gets the same treatment:
 * a visible stage while it runs, a toast that names the outcome in the same
 * words as the button that started it, a refreshed balance afterwards, and an
 * error translated into something actionable.
 */
export function useAction() {
  const { address, sign, refreshBalance } = useWallet();
  const { push } = useToast();
  const [tx, setTx] = useState<TxState>({ stage: 'idle' });

  const reset = useCallback(() => setTx({ stage: 'idle' }), []);

  const run = useCallback(
    async (options: {
      contract: ContractName;
      /** Past tense, matching the control the user pressed. */
      success: string;
      perform: (ctx: WriteContext) => Promise<InvokeResult>;
    }): Promise<InvokeResult | null> => {
      if (!address) {
        push({
          tone: 'error',
          title: 'No wallet connected',
          detail: 'Connect a wallet before signing a transaction.',
        });
        return null;
      }

      setTx({ stage: 'simulating' });

      try {
        const result = await options.perform({
          publicKey: address,
          sign,
          onStage: (stage, hash) => setTx({ stage, hash }),
        });

        push({ tone: 'success', title: options.success, hash: result.hash });
        void refreshBalance();
        return result;
      } catch (cause) {
        const described = describeError(cause, options.contract);
        setTx({ stage: 'failed', error: described.title });
        push({ tone: 'error', title: described.title, detail: described.detail });
        return null;
      }
    },
    [address, push, refreshBalance, sign],
  );

  const busy = tx.stage !== 'idle' && tx.stage !== 'success' && tx.stage !== 'failed';

  return { tx, run, reset, busy };
}
