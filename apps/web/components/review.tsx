'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  approveInvoice,
  documentUrl,
  getInvoice,
  idempotencyKey,
  rejectInvoice,
  sendToApproval,
  type ExtractedField,
  type Invoice,
  type ReasonCode,
} from '../lib/api';
import { reasonViews } from '../lib/catalog';
import { canCorrect } from '../lib/corrections';
import { minorToInput } from '../lib/money';
import { actionsFor, confidenceLevel, formatMoney, IN_FLIGHT, STATE_LABEL } from '../lib/format';
import { useBackend } from './backend';
import { CorrectionFormPanel } from './correction-form';

const FIELD_LABELS: Array<[keyof NonNullable<Invoice['extraction']>['fields'], string]> = [
  ['vendorName', 'Vendor'],
  ['invoiceNumber', 'Invoice number'],
  ['invoiceDate', 'Invoice date'],
  ['currency', 'Currency'],
  ['totalMinor', 'Total (minor units)'],
  ['subtotalMinor', 'Subtotal (minor units)'],
  ['taxMinor', 'Tax (minor units)'],
  ['dueDate', 'Due date'],
];

const CORRECTION_LABEL: Record<string, string> = {
  vendorName: 'vendor',
  invoiceNumber: 'invoice number',
  invoiceDate: 'invoice date',
  dueDate: 'due date',
  currency: 'currency',
  total: 'total',
  subtotal: 'subtotal',
  tax: 'tax',
  lineItems: 'line items',
};

const REJECT_REASONS = reasonViews().filter((r) => r.allowedOutcomes.includes('REJECTED'));
const POLL_MS = 1_500;

export function InvoiceReview({ id }: { id: string }) {
  const backend = useBackend();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const inv = await getInvoice(id);
      setInvoice(inv);
      setLoadError(null);
      if (IN_FLIGHT.has(inv.state)) timer.current = setTimeout(() => void load(), POLL_MS);
    } catch (err) {
      setLoadError(err instanceof ApiError && err.status === 404 ? 'No invoice with this id.' : 'Could not load the invoice.');
    }
  }, [id]);

  useEffect(() => {
    if (backend === 'ready') void load();
    return () => clearTimeout(timer.current);
  }, [backend, load]);

  if (loadError) return <p className="error">{loadError}</p>;
  if (!invoice) return <p className="muted">Loading…</p>;

  const busyPipeline = IN_FLIGHT.has(invoice.state);
  return (
    <div className="review">
      <section className="review-doc">
        {invoice.document?.contentType === 'application/pdf' ? (
          <iframe src={documentUrl(invoice.id)} title="Invoice document" className="doc-frame" />
        ) : (
          <img src={documentUrl(invoice.id)} alt="Invoice document" className="doc-image" />
        )}
      </section>
      <section className="review-panel">
        <div className="review-head">
          <span className={`pill pill-${invoice.state.toLowerCase()}`}>{STATE_LABEL[invoice.state]}</span>
          {busyPipeline && <span className="muted small">Extracting and validating…</span>}
        </div>
        <h1 className="title">{invoice.invoiceNumber ?? invoice.document?.filename ?? 'Invoice'}</h1>
        <p className="total">{invoice.total ? formatMoney(invoice.total.amountMinor, invoice.total.currency) : 'Total not extracted'}</p>
        {invoice.corrections && invoice.corrections.length > 0 && (
          <p className="small">
            <span className="badge">edited</span> A reviewer corrected the {invoice.corrections.map((c) => CORRECTION_LABEL[c] ?? c).join(', ')}.
          </p>
        )}

        {invoice.reasons.length > 0 && (
          <div className="reasons">
            <strong>Why it is {STATE_LABEL[invoice.state].toLowerCase()}</strong>
            <ul>
              {invoice.reasons.map((r) => (
                <li key={r}>
                  <code>{r}</code> {reasonViews().find((v) => v.code === r)?.description}
                </li>
              ))}
            </ul>
          </div>
        )}

        <InvoiceDetails invoice={invoice} />

        {editing ? (
          <CorrectionFormPanel
            invoice={invoice}
            onCancel={() => setEditing(false)}
            onSaved={(inv) => {
              setEditing(false);
              // The save response has the lines but not the history; reload for the full picture.
              setInvoice(inv);
              void load();
            }}
          />
        ) : (
          canCorrect(invoice.state) && (
            <p>
              <button className="btn" onClick={() => setEditing(true)}>
                Correct fields…
              </button>
            </p>
          )
        )}

        <h2>Extracted fields</h2>
        {invoice.extraction ? (
          <table className="table fields">
            <tbody>
              {FIELD_LABELS.map(([key, label]) => (
                <FieldRow key={key} label={label} field={invoice.extraction?.fields[key]} />
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">{busyPipeline ? 'Waiting for extraction…' : 'Nothing was extracted from this document.'}</p>
        )}
        {invoice.extraction && <p className="muted small">Extracted by {invoice.extraction.provider}. Confidence below 80% puts the invoice on hold.</p>}

        {!editing && <Actions invoice={invoice} onChange={setInvoice} />}

        <h2>History</h2>
        <ol className="history">
          {(invoice.history ?? []).map((e) => (
            <li key={e.seq}>
              <span className="muted small">{new Date(e.occurredAt).toLocaleString()}</span>{' '}
              {e.to ? (
                <>
                  {e.from ? `${STATE_LABEL[e.from]} → ` : ''}
                  <strong>{STATE_LABEL[e.to]}</strong>
                </>
              ) : (
                e.type
              )}{' '}
              <span className={`actor actor-${e.actor.kind}`}>{e.actor.kind === 'ai' ? 'AI' : e.actor.kind}: {e.actor.id}</span>
              {e.reasons && e.reasons.length > 0 && <span className="small"> ({e.reasons.join(', ')})</span>}
              {e.changes && (
                <ul className="small changes">
                  {Object.entries(e.changes).map(([field, c]) => (
                    <li key={field}>
                      {CORRECTION_LABEL[field] ?? field}: {describeValue(field, c.from)} → {describeValue(field, c.to)}
                    </li>
                  ))}
                </ul>
              )}
              {e.comment && <div className="small">“{e.comment}”</div>}
            </li>
          ))}
        </ol>
        <p>
          <Link href="/">← Upload another</Link>
        </p>
      </section>
    </div>
  );
}

const MONEY_FIELDS = new Set(['total', 'subtotal', 'tax']);

function describeValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (Array.isArray(v)) return `${v.length} line${v.length === 1 ? '' : 's'}`;
  if (MONEY_FIELDS.has(field) && typeof v === 'string') return minorToInput(v);
  return String(v);
}

function InvoiceDetails({ invoice }: { invoice: Invoice }) {
  const lines = invoice.lineItems ?? [];
  const currency = invoice.total?.currency;
  const money = (minor: string | undefined) => (minor !== undefined && currency ? formatMoney(minor, currency) : '—');
  if (!invoice.subtotal && !invoice.tax && !invoice.dueDate && lines.length === 0) return null;
  return (
    <>
      <h2>Details</h2>
      <table className="table fields">
        <tbody>
          {invoice.invoiceDate && (
            <tr>
              <th>Invoice date</th>
              <td>{invoice.invoiceDate}</td>
            </tr>
          )}
          {invoice.dueDate && (
            <tr>
              <th>Due date</th>
              <td>{invoice.dueDate}</td>
            </tr>
          )}
          {invoice.subtotal && (
            <tr>
              <th>Subtotal</th>
              <td className="num">{formatMoney(invoice.subtotal.amountMinor, invoice.subtotal.currency)}</td>
            </tr>
          )}
          {invoice.tax && (
            <tr>
              <th>Tax</th>
              <td className="num">{formatMoney(invoice.tax.amountMinor, invoice.tax.currency)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {lines.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Description</th>
              <th className="num">Qty</th>
              <th className="num">Unit price</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.position}>
                <td className="muted">{l.position}</td>
                <td>{l.description}</td>
                <td className="num">{l.quantity ?? '—'}</td>
                <td className="num">{money(l.unitPriceMinor)}</td>
                <td className="num">{money(l.amountMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function FieldRow({ label, field }: { label: string; field: ExtractedField | undefined }) {
  const confidence = field?.confidence ?? 0;
  const level = confidenceLevel(confidence);
  return (
    <tr>
      <th>{label}</th>
      <td>{field?.value ?? <span className="muted">not found</span>}</td>
      <td className="num">
        <span className={`conf conf-${level}`} title={`confidence ${confidence}`}>
          {Math.round(confidence * 100)}%
        </span>
      </td>
    </tr>
  );
}

function Actions({ invoice, onChange }: { invoice: Invoice; onChange: (inv: Invoice) => void }) {
  const actions = actionsFor(invoice.state);
  const [comment, setComment] = useState('');
  const [reasons, setReasons] = useState<ReasonCode[]>([]);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per intended action, reused on retry, so a double click cannot act twice.
  const key = useRef(idempotencyKey());

  if (actions.length === 0) return null;

  async function run(fn: () => Promise<Invoice>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
      key.current = idempotencyKey();
      setRejecting(false);
      setComment('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The request failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const note = comment.trim() || undefined;
  return (
    <div className="actions">
      <h2>Decision</h2>
      <textarea placeholder="Comment (optional, kept in the audit log)" value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} />
      {rejecting && (
        <fieldset className="reject-reasons">
          <legend>Reject because</legend>
          {REJECT_REASONS.map((r) => (
            <label key={r.code}>
              <input
                type="checkbox"
                checked={reasons.includes(r.code as ReasonCode)}
                onChange={(e) => setReasons(e.target.checked ? [...reasons, r.code as ReasonCode] : reasons.filter((c) => c !== r.code))}
              />{' '}
              <code>{r.code}</code>
            </label>
          ))}
        </fieldset>
      )}
      <div className="buttons">
        {actions.includes('approve') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => approveInvoice(invoice.id, note, key.current))}>
            Approve
          </button>
        )}
        {actions.includes('sendToApproval') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => sendToApproval(invoice.id, note, key.current))}>
            Release to approval
          </button>
        )}
        {actions.includes('reject') &&
          (rejecting ? (
            <button className="btn btn-danger" disabled={busy || reasons.length === 0} onClick={() => void run(() => rejectInvoice(invoice.id, reasons, note, key.current))}>
              Confirm rejection
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={() => setRejecting(true)}>
              Reject…
            </button>
          ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
