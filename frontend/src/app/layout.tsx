import type { Metadata } from 'next';
import { Archivo, IBM_Plex_Mono } from 'next/font/google';

import { ToastProvider } from '@/context/ToastProvider';
import { WalletProvider } from '@/context/WalletProvider';
import { NETWORK } from '@/lib/config';

import './globals.css';

const archivo = Archivo({
  variable: '--font-archivo',
  subsets: ['latin'],
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'StellarPact — milestone escrow on Stellar',
  description:
    'Lock XLM into a contract per deal, release it milestone by milestone, and build reputation that cannot be forged.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning is here for exactly one reason: StellarWalletsKit
    // writes its theme variables straight onto the document element
    // (`documentElement.style.setProperty('--swk-…')`) as soon as its module
    // evaluates in the browser. That gives <html> a style attribute the server
    // never rendered, which React reports as a hydration mismatch even though
    // nothing in this app is inconsistent.
    //
    // The attribute only suppresses diffing one level deep — on <html> itself —
    // so a genuine mismatch anywhere in the tree below still surfaces.
    <html
      lang="en"
      className={`${archivo.variable} ${plexMono.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="min-h-dvh flex flex-col bg-ink text-text" data-network={NETWORK}>
        <ToastProvider>
          <WalletProvider>{children}</WalletProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
