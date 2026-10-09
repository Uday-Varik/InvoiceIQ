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
      { href: '/', label: 'Dashboard' },
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
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-border bg-card md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-4 py-3 md:py-5">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold text-foreground no-underline">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-xs text-primary-foreground">IQ</span>
            InvoiceIQ
          </Link>
        </div>
        <nav aria-label="Main navigation" className="flex flex-wrap gap-1 px-3 pb-3 md:flex-col md:flex-nowrap md:gap-0.5">
          {SECTIONS.map((section) => (
            <div key={section.label} className="contents md:block md:pt-3">
              <div className="hidden px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:block">
                {section.label}
              </div>
              {section.links.map((link) => {
                const active = isActive(pathname, link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-3 py-1.5 text-sm no-underline transition-colors',
                      active ? 'bg-muted font-semibold text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="hidden border-t border-border p-3 text-sm md:block">
          <AuthNotice />
        </div>
      </aside>
      <main id="main-content" className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto w-full max-w-6xl space-y-6">{children}</div>
      </main>
    </div>
  );
}
