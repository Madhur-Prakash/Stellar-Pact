/**
 * Wallet wiring for StellarWalletsKit v2.
 *
 * The kit is a static singleton in this version, so initialisation has to
 * happen exactly once and only in the browser — the modules touch `window`
 * during construction, which would break server rendering.
 *
 * Modules are imported individually rather than through a catch-all so the
 * bundle only carries wallets this app actually offers.
 */

import { StellarWalletsKit, Networks } from '@creit.tech/stellar-wallets-kit';
import { AlbedoModule } from '@creit.tech/stellar-wallets-kit/modules/albedo';
import { FreighterModule } from '@creit.tech/stellar-wallets-kit/modules/freighter';
import { HanaModule } from '@creit.tech/stellar-wallets-kit/modules/hana';
import { LobstrModule } from '@creit.tech/stellar-wallets-kit/modules/lobstr';
import { RabetModule } from '@creit.tech/stellar-wallets-kit/modules/rabet';
import { xBullModule } from '@creit.tech/stellar-wallets-kit/modules/xbull';

import { NETWORK } from './config';

const KIT_NETWORK: Networks =
  NETWORK === 'mainnet' || NETWORK === 'public'
    ? Networks.PUBLIC
    : NETWORK === 'futurenet'
      ? Networks.FUTURENET
      : Networks.TESTNET;

let started = false;

export function initWallets(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  StellarWalletsKit.init({
    network: KIT_NETWORK,
    modules: [
      new FreighterModule(),
      new xBullModule(),
      new AlbedoModule(),
      new RabetModule(),
      new LobstrModule(),
      new HanaModule(),
    ],
    authModal: { showInstallLabel: true },
  });
}

/** Remembers the last wallet so a reload does not force a reconnect. */
const STORAGE_KEY = 'stellarpact.address';

export const remembered = {
  read(): string | null {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  write(address: string | null) {
    if (typeof window === 'undefined') return;
    try {
      if (address) window.localStorage.setItem(STORAGE_KEY, address);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private browsing blocks storage; connecting still works, it just
      // won't survive a reload.
    }
  },
};

export { StellarWalletsKit };
