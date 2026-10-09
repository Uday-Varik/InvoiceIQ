'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  cancelPaymentRun,
  confirmPaymentRun,
  createPaymentRun,
  getPaymentRun,
  idempotencyKey,
  listPaymentRuns,
  paymentFileUrl,
  type PaymentRun,
  type PaymentRunResult,
} from '../lib/api';
import { canAssemble, confirmBlocker, RUN_STATUS_LABEL, runResultText, runTotal } from '../lib/controls';
import { formatMoney, STATE_LABEL } from '../lib/format';
import type { InvoiceState } from '../lib/api';
import { personaLabel } from '../lib/personas';
import { useBackend } from './backend';
import { useMe } from './me';
import { inputClass, textareaClass } from './ui/field';
import { Notice } from './ui/notice';
import { cn } from '../lib/utils';
import { PageHeader } from './page-header';
import { Badge } from './ui/badge';
import { Button, buttonVariants } from './ui/button';
import { Card } from './ui/card';
import { Table, TableCell, TableHead, TableRow } from './ui/table';

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'The request failed. Try again.');

const RUN_TONE: Record<string, 'queued' | 'success' | 'hold' | 'neutral'> = {
  queued: 'queued',
  paid: 'success',
  cancelled: 'hold',
};

function RunBadge({ status }: { status: string }) {
  return <Badge tone={RUN_TONE[status] ?? 'neutral'}>{RUN_STATUS_LABEL[status as PaymentRun['status']]}</Badge>;
}

export function PaymentRuns() {
  const backend = useBackend();
  const me = useMe();
  const [runs, setRuns] = useState<readonly PaymentRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currency, setCurrency] = useState('USD');
  const [comment, setComment] = useState('');
  const [result, setResult] = useState<PaymentRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(idempotencyKey());

  const load = useCallback(async () => {
    try {
      setRuns((await listPaymentRuns()).items);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    if (backend === 'ready') void load();
  }, [backend, load]);

  async function assemble(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await createPaymentRun(currency.trim().toUpperCase(), comment.trim() || undefined, key.current));
      key.current = idempotencyKey();
      setComment('');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payment runs"
        description="A manager assembles approved invoices into a run. A controller who did not assemble it confirms it was paid."
      />
      {canAssemble(me) ? (
        <Card className="p-4">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => void assemble(e)} aria-label="Assemble a payment run">
            <label className="grid w-28 gap-1 text-sm">
              <span className="text-muted-foreground">Currency</span>
              <input className={inputClass} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
            </label>
            <label className="grid min-w-48 flex-1 gap-1 text-sm">
              <span className="text-muted-foreground">Comment</span>
              <input className={inputClass} value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} placeholder="Weekly run" />
            </label>
            <Button type="submit" disabled={busy || !/^[A-Za-z]{3}$/.test(currency.trim())}>
              Assemble run from approved invoices
            </Button>
          </form>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">Assembling a payment run needs an AP manager or above.</p>
      )}
      {result && (
        <p className={result.held.length > 0 ? 'text-sm text-amber-800 dark:text-amber-300' : 'text-sm text-muted-foreground'}>{runResultText(result)}</p>
      )}
      {error && (
        <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">
          {error}
        </p>
      )}
      {runs && runs.length === 0 && <Card className="p-6 text-sm text-muted-foreground">No payment runs yet.</Card>}
      {runs && runs.length > 0 && (
        <Card className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Invoices</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Assembled by</TableHead>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link href={`/payments/${r.id}`} className="font-medium text-primary hover:underline">
                      {new Date(r.createdAt).toLocaleString()}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <RunBadge status={r.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.invoiceCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{runTotal(r)}</TableCell>
                  <TableCell>{personaLabel(r.createdBy)}</TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

export function PaymentRunPage({ id }: { id: string }) {
  const backend = useBackend();
  const me = useMe();
  const [run, setRun] = useState<PaymentRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(idempotencyKey());

  const load = useCallback(async () => {
    try {
      setRun(await getPaymentRun(id));
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    if (backend === 'ready') void load();
  }, [backend, load]);

  if (error && !run) return <p className="text-sm text-rose-700 dark:text-rose-300">{error}</p>;
  if (!run) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const blocker = confirmBlocker(me, run);

  async function act(fn: () => Promise<PaymentRun>) {
    setBusy(true);
    setError(null);
    try {
      setRun(await fn());
      key.current = idempotencyKey();
      setComment('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/payments" className="text-sm text-primary hover:underline">
        ← All payment runs
      </Link>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight tabular-nums">Payment run: {runTotal(run)}</h1>
          <RunBadge status={run.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          Assembled by {personaLabel(run.createdBy)} on {new Date(run.createdAt).toLocaleString()}
          {run.comment ? `: ${run.comment}` : ''}
          {run.closedBy && run.closedAt
            ? `. ${RUN_STATUS_LABEL[run.status]} by ${personaLabel(run.closedBy)} on ${new Date(run.closedAt).toLocaleString()}`
            : ''}
          {run.closeComment ? `: ${run.closeComment}` : ''}
        </p>
      </header>

      <Card className="overflow-x-auto">
        <Table>
          <thead>
            <tr>
              <TableHead>Vendor</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead>Due</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>State</TableHead>
            </tr>
          </thead>
          <tbody>
            {(run.items ?? []).map((it) => (
              <TableRow key={it.invoiceId}>
                <TableCell>
                  <Link href={`/vendors/${it.vendorId}`} className="text-primary hover:underline">
                    {it.vendorName}
                  </Link>
                </TableCell>
                <TableCell className="tabular-nums">{it.accountLast4 ? `…${it.accountLast4}` : 'on file'}</TableCell>
                <TableCell>
                  <Link href={`/invoices/${it.invoiceId}`} className="text-primary hover:underline">
                    {it.invoiceNumber ?? it.invoiceId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell className="tabular-nums">{it.dueDate ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(it.amount.amountMinor, it.amount.currency)}</TableCell>
                <TableCell>{STATE_LABEL[it.state as InvoiceState]}</TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      </Card>

      {error && (
        <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">
          {error}
        </p>
      )}
      {run.status !== 'cancelled' && (
        <div>
          <a className={buttonVariants({ variant: 'outline' })} href={paymentFileUrl(run.id)} download>
            Download payment file (CSV)
          </a>
        </div>
      )}
      {run.status === 'queued' && (
        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Close the run</h2>
          <textarea
            placeholder="Comment (required to cancel)"
            value={comment}
            maxLength={2000}
            onChange={(e) => setComment(e.target.value)}
            className={cn(textareaClass, 'min-h-20')}
          />
          {blocker && <Notice>{blocker}</Notice>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || blocker !== undefined} onClick={() => void act(() => confirmPaymentRun(run.id, run.version, comment.trim() || undefined, key.current))}>
              Confirm paid
            </Button>
            <Button
              variant="outline"
              className="border-rose-300 text-rose-700 hover:bg-rose-50 dark:text-rose-300"
              disabled={busy || !comment.trim()}
              onClick={() => void act(() => cancelPaymentRun(run.id, run.version, comment.trim(), key.current))}
            >
              Cancel run
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
