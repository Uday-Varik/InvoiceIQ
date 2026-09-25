'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { API_BASE } from '../lib/api';
import { waitForBackend, type BackendStatus } from '../lib/wake';

const BackendContext = createContext<BackendStatus>('checking');

export function useBackend(): BackendStatus {
  return useContext(BackendContext);
}

export function BackendProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<BackendStatus>('checking');
  useEffect(() => {
    const ctrl = new AbortController();
    void waitForBackend({ url: `${API_BASE}/healthz`, onStatus: setStatus, signal: ctrl.signal });
    return () => ctrl.abort();
  }, []);
  return (
    <BackendContext.Provider value={status}>
      <WakeBanner status={status} />
      {children}
    </BackendContext.Provider>
  );
}

function WakeBanner({ status }: { status: BackendStatus }) {
  if (status === 'waking') {
    return (
      <div className="banner banner-waking" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <div>
          <strong>Waking the demo…</strong>
          <p>
            The API runs on a free tier that sleeps when nobody is using it. The first request takes up to a minute while
            it starts. This page will carry on by itself.
          </p>
        </div>
      </div>
    );
  }
  if (status === 'down') {
    return (
      <div className="banner banner-down" role="alert">
        <strong>The demo backend is not answering.</strong>
        <p>It may be redeploying or over its free-tier limits. Try again in a few minutes.</p>
      </div>
    );
  }
  return null;
}
