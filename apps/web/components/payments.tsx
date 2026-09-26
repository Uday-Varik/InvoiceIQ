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

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'The request failed. Try again.');

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
    <div>
      {canAssemble(me) ? (
        <form className="filters" onSubmit={(e) => void assemble(e)} aria-label="Assemble a payment run">
          <label>
            Currency
            <input value={currency} maxLength={3} size={4} onChange={(e) => setCurrency(e.target.value)} />
          </label>
          <label>
            Comment
            <input value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} placeholder="Weekly run" />
          </label>
          <div className="buttons">
            <button className="btn btn-primary" type="submit" disabled={busy || !/^[A-Za-z]{3}$/.test(currency.trim())}>
              Assemble run from approved invoices
            </button>
          </div>
        </form>
      ) : (
        <p className="muted small">Assembling a payment run needs an AP manager or above.</p>
      )}
      {result && <p className={result.held.length > 0 ? 'warn' : 'muted'}>{runResultText(result)}</p>}
      {error && <p className="error">{error}</p>}
      {runs && runs.length === 0 && <p className="muted">No payment runs yet.</p>}
      {runs && runs.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th className="num">Invoices</th>
              <th className="num">Total</th>
              <th>Assembled by</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/payments/${r.id}`}>{new Date(r.createdAt).toLocaleString()}</Link>
                </td>
                <td>
                  <span className={`pill pill-run-${r.status}`}>{RUN_STATUS_LABEL[r.status]}</span>
                </td>
                <td className="num">{r.invoiceCount}</td>
                <td className="num">{runTotal(r)}</td>
                <td>{personaLabel(r.createdBy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

  if (error && !run) return <p className="error">{error}</p>;
  if (!run) return <p className="muted">Loading…</p>;
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
    <div>
      <p>
        <Link href="/payments">← All payment runs</Link>
      </p>
      <h1>
        Payment run: {runTotal(run)} <span className={`pill pill-run-${run.status}`}>{RUN_STATUS_LABEL[run.status]}</span>
      </h1>
      <p className="muted small">
        Assembled by {personaLabel(run.createdBy)} on {new Date(run.createdAt).toLocaleString()}
        {run.comment ? `: ${run.comment}` : ''}
        {run.closedBy && run.closedAt ? `. ${RUN_STATUS_LABEL[run.status]} by ${personaLabel(run.closedBy)} on ${new Date(run.closedAt).toLocaleString()}` : ''}
        {run.closeComment ? `: ${run.closeComment}` : ''}
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Account</th>
            <th>Invoice</th>
            <th>Due</th>
            <th className="num">Amount</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {(run.items ?? []).map((it) => (
            <tr key={it.invoiceId}>
              <td>
                <Link href={`/vendors/${it.vendorId}`}>{it.vendorName}</Link>
              </td>
              <td>{it.accountLast4 ? `…${it.accountLast4}` : 'on file'}</td>
              <td>
                <Link href={`/invoices/${it.invoiceId}`}>{it.invoiceNumber ?? it.invoiceId.slice(0, 8)}</Link>
              </td>
              <td>{it.dueDate ?? '—'}</td>
              <td className="num">{formatMoney(it.amount.amountMinor, it.amount.currency)}</td>
              <td>{STATE_LABEL[it.state as InvoiceState]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="error">{error}</p>}
      {run.status !== 'cancelled' && (
        <p>
          <a className="btn" href={paymentFileUrl(run.id)} download>
            Download payment file (CSV)
          </a>
        </p>
      )}
      {run.status === 'queued' && (
        <div className="actions">
          <h2>Close the run</h2>
          <textarea placeholder="Comment (required to cancel)" value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} />
          {blocker && <p className="warn small">{blocker}</p>}
          <div className="buttons">
            <button
              className="btn btn-primary"
              disabled={busy || blocker !== undefined}
              onClick={() => void act(() => confirmPaymentRun(run.id, run.version, comment.trim() || undefined, key.current))}
            >
              Confirm paid
            </button>
            <button className="btn btn-danger" disabled={busy || !comment.trim()} onClick={() => void act(() => cancelPaymentRun(run.id, run.version, comment.trim(), key.current))}>
              Cancel run
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
