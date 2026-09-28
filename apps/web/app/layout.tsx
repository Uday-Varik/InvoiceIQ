import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AuthNotice } from '../components/auth-notice';
import { BackendProvider } from '../components/backend';
import { MeProvider } from '../components/me';
import './globals.css';

export const metadata: Metadata = {
  title: 'InvoiceIQ',
  description: 'Accounts-payable automation with a payment-safety control layer',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <header className="topbar">
          <Link href="/" className="brand">
            InvoiceIQ
          </Link>
          <nav aria-label="Main navigation">
            <ul className="nav-links">
              <li>
                <Link href="/invoices">Invoices</Link>
              </li>
              <li>
                <Link href="/vendors">Vendors</Link>
              </li>
              <li>
                <Link href="/payments">Payment runs</Link>
              </li>
              <li>
                <Link href="/audit">Audit</Link>
              </li>
              <li>
                <Link href="/lifecycle">Lifecycle</Link>
              </li>
              <li>
                <Link href="/admin">Admin</Link>
              </li>
            </ul>
          </nav>
          <AuthNotice />
        </header>
        <main id="main-content" className="container">
          <BackendProvider>
            <MeProvider>{children}</MeProvider>
          </BackendProvider>
        </main>
      </body>
    </html>
  );
}
