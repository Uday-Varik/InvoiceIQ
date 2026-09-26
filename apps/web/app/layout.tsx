import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BackendProvider } from '../components/backend';
import { MeProvider } from '../components/me';
import './globals.css';

export const metadata: Metadata = {
  title: 'InvoiceIQ',
  description: 'Accounts-payable automation with a payment-safety control layer',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            InvoiceIQ
          </Link>
          <Link href="/invoices" className="small">
            Invoices
          </Link>
          <Link href="/vendors" className="small">
            Vendors
          </Link>
          <Link href="/payments" className="small">
            Payment runs
          </Link>
          <Link href="/audit" className="small">
            Audit
          </Link>
          <Link href="/lifecycle" className="small">
            Lifecycle and reason codes
          </Link>
          <span className="muted small">Public demo: every visitor shares one demo tenant</span>
        </header>
        <main className="container">
          <BackendProvider>
            <MeProvider>{children}</MeProvider>
          </BackendProvider>
        </main>
      </body>
    </html>
  );
}
