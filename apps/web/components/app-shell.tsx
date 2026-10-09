'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { AuthNotice } from './auth-notice';

const SECTIONS: readonly { label: string; links: readonly { href: Route; label: string }[] }[] = [
  {
    label: 'Work',
    links: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/invoices', label: 'Invoices' },
      { href: '/vendors', label: 'Vendors' },
      { href: '/payments', label: 'Payment runs' },
    ],
  },
  {
    label: 'Insight',
    links: [
      { href: '/reports', label: 'Reports' },
      { href: '/audit', label: 'Audit log' },
    ],
  },
  {
    label: 'Help',
    links: [{ href: '/lifecycle', label: 'Invoice states' }],
  },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="bg-navy text-navy-text md:sticky md:top-0 md:flex md:h-screen md:w-60 md:shrink-0 md:flex-col">
        <div className="flex items-center gap-2.5 px-4 py-3 md:py-5">
          <Link href="/dashboard" className="flex items-center gap-2.5 text-sm font-semibold text-navy-text-strong no-underline">
            <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-md bg-accent text-xs font-bold text-accent-text">
              IQ
            </span>
            InvoiceIQ
          </Link>
        </div>
        <nav aria-label="Main navigation" className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:gap-0.5 md:overflow-visible">
          {SECTIONS.map((section) => (
            <div key={section.label} className="contents md:block md:pt-4">
              <div className="hidden px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-navy-text/70 md:block">{section.label}</div>
              {section.links.map((link) => {
                const active = isActive(pathname, link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block shrink-0 rounded-md px-3 py-1.5 text-sm no-underline transition-colors focus-visible:outline-accent',
                      active
                        ? 'bg-navy-line font-semibold text-navy-text-strong shadow-[inset_2px_0_0_var(--accent)]'
                        : 'text-navy-text hover:bg-navy-line hover:text-navy-text-strong',
                    )}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="hidden border-t border-navy-line p-3 text-sm md:block">
          <AuthNotice />
        </div>
      </aside>
      <main id="main-content" className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto w-full max-w-6xl space-y-6">{children}</div>
      </main>
    </div>
  );
}
