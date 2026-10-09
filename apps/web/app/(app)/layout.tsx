import Link from 'next/link';
import type { ReactNode } from 'react';
import { AuthNotice } from '../../components/auth-notice';
import { BackendProvider } from '../../components/backend';
import { MeProvider } from '../../components/me';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <Link href="/dashboard" className="brand">
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
              <Link href="/reports">Reports</Link>
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
    </>
  );
}
