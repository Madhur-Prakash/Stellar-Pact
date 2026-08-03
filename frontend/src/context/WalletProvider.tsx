'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { describeError, type PactError } from '@/lib/errors';
import { fetchXlmBalance, type SignTransaction } from '@/lib/stellar';
import { initWallets, remembered, StellarWalletsKit } from '@/lib/wallet';

interface WalletState {
  address: string | null;
  connecting: boolean;
  /** Stroops. `null` means the account is not funded on this network. */
  balance: bigint | null;
  balanceLoading: boolean;
  error: PactError | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  sign: SignTransaction;
  dismissError: () => void;
}

const WalletContext = createContext<WalletState | null>(null);

/** Tagged with the address it belongs to, so a stale fetch can never be shown. */
interface BalanceOf {
  address: string;
  stroops: bigint | null;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [balanceOf, setBalanceOf] = useState<BalanceOf | null>(null);
  const [balanceNonce, setBalanceNonce] = useState(0);
  const [error, setError] = useState<PactError | null>(null);

  useEffect(() => {
    initWallets();

    // A remembered address is a hint, not a session: the kit still has to
    // confirm the wallet is present and unlocked before we trust it.
    const previous = remembered.read();
    if (!previous) return;

    StellarWalletsKit.getAddress()
      .then(({ address: found }) => {
        if (found) setAddress(found);
      })
      .catch(() => {
        remembered.write(null);
      });
  }, []);

  useEffect(() => {
    if (!address) return;
    let current = true;

    fetchXlmBalance(address)
      .then((stroops) => {
        if (current) setBalanceOf({ address, stroops });
      })
      .catch((cause) => {
        if (!current) return;
        setBalanceOf({ address, stroops: null });
        setError(describeError(cause));
      });

    return () => {
      current = false;
    };
  }, [address, balanceNonce]);

  const balance = balanceOf && balanceOf.address === address ? balanceOf.stroops : null;
  const balanceLoading = address !== null && balanceOf?.address !== address;

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      initWallets();
      const { address: picked } = await StellarWalletsKit.authModal();
      setAddress(picked);
      remembered.write(picked);
    } catch (cause) {
      const described = describeError(cause);
      // Closing the picker is a choice, not a failure worth shouting about.
      if (described.kind !== 'wallet-rejected') setError(described);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await StellarWalletsKit.disconnect();
    } catch {
      // Some modules have nothing to tear down; dropping local state is
      // what actually disconnects the app either way.
    }
    setAddress(null);
    setBalanceOf(null);
    setError(null);
    remembered.write(null);
  }, []);

  const refreshBalance = useCallback(async () => {
    setBalanceNonce((value) => value + 1);
  }, []);

  const sign = useCallback<SignTransaction>(async (xdr, opts) => {
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, opts);
    return { signedTxXdr };
  }, []);

  const value = useMemo<WalletState>(
    () => ({
      address,
      connecting,
      balance,
      balanceLoading,
      error,
      connect,
      disconnect,
      refreshBalance,
      sign,
      dismissError: () => setError(null),
    }),
    [address, connecting, balance, balanceLoading, error, connect, disconnect, refreshBalance, sign],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (!context) throw new Error('useWallet must be used inside <WalletProvider>');
  return context;
}
