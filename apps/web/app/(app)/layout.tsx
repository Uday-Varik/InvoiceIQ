import type { ReactNode } from 'react';
import { AppShell } from '../../components/app-shell';
import { BackendProvider } from '../../components/backend';
import { MeProvider } from '../../components/me';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell>
      <BackendProvider>
        <MeProvider>{children}</MeProvider>
      </BackendProvider>
    </AppShell>
  );
}
