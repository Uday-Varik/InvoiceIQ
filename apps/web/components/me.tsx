'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getMe, type Me } from '../lib/api';
import { personaCookie, personaOptions, roleLabel } from '../lib/personas';
import { useBackend } from './backend';

const MeContext = createContext<Me | undefined>(undefined);

/** The caller as core-api sees them; undefined until the backend answers. */
export function useMe(): Me | undefined {
  return useContext(MeContext);
}

export function MeProvider({ children }: { children: ReactNode }) {
  const backend = useBackend();
  const [me, setMe] = useState<Me | undefined>(undefined);
  useEffect(() => {
    if (backend !== 'ready') return;
    getMe()
      .then(setMe)
      .catch(() => setMe(undefined));
  }, [backend]);
  return (
    <MeContext.Provider value={me}>
      {me?.authMode === 'demo' && <PersonaBar me={me} />}
      {children}
    </MeContext.Provider>
  );
}

/**
 * Demo only: act as a different person, so separation of duties can be tried
 * in one browser (a clerk uploads, a manager approves, a controller pays).
 */
function PersonaBar({ me }: { me: Me }) {
  return (
    <div className="persona-bar">
      <label>
        Acting as{' '}
        <select
          value={me.userId}
          onChange={(e) => {
            document.cookie = personaCookie(e.target.value === 'demo-user' ? null : e.target.value);
            window.location.reload();
          }}
        >
          {personaOptions(me).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <span className="muted small">Roles: {me.roles.map(roleLabel).join(', ') || 'none'}</span>
    </div>
  );
}
