import type { ReactNode } from 'react';
import { AppShell } from '../../components/app-shell';
import { BackendProvider } from '../../components/backend';
import { MeProvider } from '../../components/me';

export default function AppLayout({ children }: { children: ReactNode }) {
  // The providers must wrap the shell: the shell's footer (AuthNotice)
  // reads the signed-in identity from MeProvider, and a context value
  // is only visible below its provider. With the shell outside, the
  // identity and Sign out never rendered in any mode.
  return (
    <BackendProvider>
      <MeProvider>
        <AppShell>{children}</AppShell>
      </MeProvider>
    </BackendProvider>
  );
}
