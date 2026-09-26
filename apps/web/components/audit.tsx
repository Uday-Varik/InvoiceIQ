'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  createCheckpoint,
  listCheckpoints,
  verifyAudit,
  verifyCheckpoint,
  type AuditCheckpointList,
  type AuditCheckpointVerification,
  type AuditVerification,
} from '../lib/api';
import { checkpointText, covers, parseCheckpoint } from '../lib/controls';
import { personaLabel } from '../lib/personas';
import { useBackend } from './backend';
import { useMe } from './me';

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'The request failed. Try again.');

export function AuditPanel() {
  const backend = useBackend();
  const me = useMe();
  const [chain, setChain] = useState<AuditVerification | null>(null);
  const [list, setList] = useState<AuditCheckpointList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [check, setCheck] = useState<AuditCheckpointVerification | string | null>(null);

  const load = useCallback(async () => {
    try {
      const [v, l] = await Promise.all([verifyAudit(), listCheckpoints()]);
      setChain(v);
      setList(l);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    if (backend === 'ready') void load();
  }, [backend, load]);

  async function sign() {
    setError(null);
    try {
      await createCheckpoint();
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function verifyPasted() {
    const parsed = parseCheckpoint(pasted);
    if (!parsed.ok) {
      setCheck(parsed.error);
      return;
    }
    try {
      setCheck(await verifyCheckpoint(parsed.checkpoint));
    } catch (err) {
      setCheck(errorText(err));
    }
  }

  return (
    <div>
      {chain && (
        <p>
          <span className={`pill ${chain.ok ? 'pill-approved' : 'pill-exception'}`}>{chain.ok ? 'Chain intact' : 'Chain broken'}</span>{' '}
          <span className="small">
            {chain.entries} entries, {chain.checkpointsChecked ?? 0} checkpoint{chain.checkpointsChecked === 1 ? '' : 's'} checked
            {!chain.ok && chain.reason ? `: ${chain.reason}` : ''}
          </span>
        </p>
      )}
      {error && <p className="error">{error}</p>}

      <h2>Signed checkpoints</h2>
      <p className="muted small">
        A checkpoint is a signed statement of the chain&apos;s latest entry. Save or publish a copy somewhere this database&apos;s owner cannot
        edit (an email to your auditors, a ticket). If the chain is ever rewritten, that copy stops verifying.
      </p>
      {me && covers(me.roles, 'ap_manager') && (
        <div className="buttons">
          <button className="btn btn-primary" onClick={() => void sign()}>
            Sign the current head
          </button>
        </div>
      )}
      {list && (
        <>
          <p className="small">
            Signing key id <code>{list.currentKeyId}</code>
          </p>
          {list.items.length === 0 ? (
            <p className="muted">No checkpoints yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th className="num">Entry</th>
                  <th>Hash</th>
                  <th>Signed</th>
                  <th>Copy</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((cp) => (
                  <tr key={cp.seq}>
                    <td className="num">{cp.seq}</td>
                    <td>
                      <code>{cp.hash.slice(0, 16)}…</code>
                    </td>
                    <td>
                      {cp.createdBy ? personaLabel(cp.createdBy) : ''} {new Date(cp.createdAt).toLocaleString()} (key {cp.keyId})
                    </td>
                    <td>
                      <button className="btn btn-small" onClick={() => void navigator.clipboard.writeText(checkpointText(cp))}>
                        Copy JSON
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <h2>Check a saved checkpoint</h2>
      <div className="correction">
        <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste a checkpoint JSON you kept" rows={8} />
        <div className="buttons">
          <button className="btn" disabled={!pasted.trim()} onClick={() => void verifyPasted()}>
            Verify
          </button>
        </div>
        {typeof check === 'string' && <p className="error">{check}</p>}
        {check && typeof check === 'object' && (
          <p className={check.ok ? '' : 'error'}>
            {check.ok ? `Entry ${check.seq ?? ''} is unchanged.` : `Does not verify: ${check.reason ?? 'unknown reason'}.`}{' '}
            {check.trustedKey ? 'Signed with this deployment’s key.' : 'Signed with a key this deployment has never used: compare the key id with the one you pinned.'}
          </p>
        )}
      </div>
    </div>
  );
}
