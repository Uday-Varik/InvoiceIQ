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
import { PageHeader } from './page-header';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { sectionTitleClass } from './ui/field';
import { Table, TableCell, TableHead, TableRow } from './ui/table';

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
    <div className="space-y-6">
      <PageHeader title="Audit log" description="Every change is recorded in order. Nothing can be edited or removed after it is written." />

      {chain && (
        <Card className="flex flex-wrap items-center gap-4 p-5">
          <span
            className={
              chain.ok
                ? 'grid size-10 place-items-center rounded-full bg-emerald-100 text-sm font-semibold text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300'
                : 'grid size-10 place-items-center rounded-full bg-rose-100 text-sm font-semibold text-rose-700 dark:bg-rose-400/15 dark:text-rose-300'
            }
            aria-hidden="true"
          >
            {chain.ok ? 'OK' : '!'}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 font-semibold">
              {chain.ok ? 'Audit chain intact' : 'Audit chain broken'}
              <Badge tone={chain.ok ? 'success' : 'hold'}>{chain.ok ? 'Verified' : 'Needs attention'}</Badge>
            </div>
            <p className="text-sm text-muted-foreground tabular-nums">
              {chain.entries} entries, {chain.checkpointsChecked ?? 0} checkpoint{chain.checkpointsChecked === 1 ? '' : 's'} checked
              {!chain.ok && chain.reason ? `: ${chain.reason}` : ''}
            </p>
          </div>
          {me && covers(me.roles, 'ap_manager') && <Button onClick={() => void sign()}>Sign current state</Button>}
        </Card>
      )}
      {error && (
        <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">
          {error}
        </p>
      )}

      <section className="space-y-3">
        <h2 className={sectionTitleClass}>Signed checkpoints</h2>
        <p className="text-sm text-muted-foreground">
          A checkpoint is a signed statement of the chain&apos;s latest entry. Save or publish a copy somewhere this database&apos;s owner cannot
          edit (an email to your auditors, a ticket). If the chain is ever rewritten, that copy stops verifying.
        </p>
        {list && (
          <>
            <p className="text-sm text-muted-foreground">
              Signing key id <code className="font-mono text-xs">{list.currentKeyId}</code>
            </p>
            {list.items.length === 0 ? (
              <Card className="p-4 text-sm text-muted-foreground">No checkpoints yet.</Card>
            ) : (
              <Card className="overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <TableHead className="text-right">Entry</TableHead>
                      <TableHead>Hash</TableHead>
                      <TableHead>Signed</TableHead>
                      <TableHead>Copy</TableHead>
                    </tr>
                  </thead>
                  <tbody>
                    {list.items.map((cp) => (
                      <TableRow key={cp.seq}>
                        <TableCell className="text-right tabular-nums">{cp.seq}</TableCell>
                        <TableCell>
                          <code className="font-mono text-xs">{cp.hash.slice(0, 16)}…</code>
                        </TableCell>
                        <TableCell className="text-sm">
                          {cp.createdBy ? personaLabel(cp.createdBy) : ''} {new Date(cp.createdAt).toLocaleString()}{' '}
                          <span className="text-muted-foreground">(key {cp.keyId})</span>
                        </TableCell>
                        <TableCell>
                          <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(checkpointText(cp))}>
                            Copy JSON
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </tbody>
                </Table>
              </Card>
            )}
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className={sectionTitleClass}>Check a saved checkpoint</h2>
        <Card className="space-y-3 p-5">
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="Paste a checkpoint JSON you kept"
            rows={8}
            className="w-full rounded-md border border-border bg-background p-3 font-mono text-xs focus:outline-2 focus:outline-offset-1 focus:outline-ring"
          />
          <div>
            <Button variant="outline" disabled={!pasted.trim()} onClick={() => void verifyPasted()}>
              Verify
            </Button>
          </div>
          {typeof check === 'string' && (
            <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">
              {check}
            </p>
          )}
          {check && typeof check === 'object' && (
            <p className={check.ok ? 'text-sm' : 'text-sm text-rose-700 dark:text-rose-300'}>
              {check.ok ? `Entry ${check.seq ?? ''} is unchanged.` : `Does not verify: ${check.reason ?? 'unknown reason'}.`}{' '}
              {check.trustedKey ? 'Signed with this deployment’s key.' : 'Signed with a key this deployment has never used: compare the key id with the one you pinned.'}
            </p>
          )}
        </Card>
      </section>
    </div>
  );
}
