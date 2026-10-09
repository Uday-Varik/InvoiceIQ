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
import { approvalProgress, approveBlocker } from '../lib/controls';
import { personaLabel } from '../lib/personas';
import { cn } from '../lib/utils';
import { useBackend } from './backend';
import { useMe } from './me';
import { CorrectionFormPanel } from './correction-form';
import { PipelineProgress } from './pipeline-progress';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Notice } from './ui/notice';
import { sectionTitleClass, textareaClass } from './ui/field';
import { StatusBadge } from './ui/status-badge';
import { Table, TableCell, TableHead, TableRow } from './ui/table';

const FIELD_LABELS: Array<[keyof NonNullable<Invoice['extraction']>['fields'], string]> = [
  ['vendorName', 'Vendor'],
  ['invoiceNumber', 'Invoice number'],
  ['invoiceDate', 'Invoice date'],
  ['currency', 'Currency'],
  ['totalMinor', 'Total (minor units)'],
  ['subtotalMinor', 'Subtotal (minor units)'],
  ['taxMinor', 'Tax (minor units)'],
  ['dueDate', 'Due date'],
  ['paymentTerms', 'Payment terms'],
  ['poNumber', 'PO number'],
  ['vendorAddress', 'Vendor address'],
  ['vendorTaxId', 'Tax ID'],
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
  paymentTerms: 'payment terms',
  poNumber: 'PO number',
  vendorAddress: 'vendor address',
  vendorTaxId: 'tax ID',
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

  if (loadError) return <p className="text-sm text-rose-700 dark:text-rose-300">{loadError}</p>;
  if (!invoice) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const busyPipeline = IN_FLIGHT.has(invoice.state);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <Card className="overflow-hidden lg:sticky lg:top-6 lg:self-start">
        {invoice.document?.contentType === 'application/pdf' ? (
          <iframe src={documentUrl(invoice.id)} title="Invoice document" className="h-[80vh] w-full" loading="lazy" />
        ) : (
          <img src={documentUrl(invoice.id)} alt={`Scanned invoice ${invoice.invoiceNumber ?? ''}`} className="w-full" loading="lazy" />
        )}
      </Card>

      <section className="min-w-0 space-y-6">
        <div className="space-y-2">
          <StatusBadge state={invoice.state} />
          <h1 className="text-2xl font-semibold tracking-tight">{invoice.invoiceNumber ?? invoice.document?.filename ?? 'Invoice'}</h1>
          <p className="text-3xl font-semibold tabular-nums">
            {invoice.total ? (
              formatMoney(invoice.total.amountMinor, invoice.total.currency)
            ) : busyPipeline ? (
              <span className="inline-block h-8 w-40 animate-pulse rounded bg-muted" aria-hidden="true" />
            ) : (
              <span className="text-base font-normal text-muted-foreground">Total not extracted</span>
            )}
          </p>
        </div>

        <PipelineProgress invoice={invoice} />

        {invoice.corrections && invoice.corrections.length > 0 && (
          <p className="text-sm text-muted-foreground">
            <Badge className="mr-1">edited</Badge> A reviewer corrected the {invoice.corrections.map((c) => CORRECTION_LABEL[c] ?? c).join(', ')}.
          </p>
        )}

        {invoice.reasons.length > 0 && (
          <Card className="space-y-2 border-amber-200 bg-amber-50 p-4 dark:border-amber-400/30 dark:bg-amber-400/10">
            <p className="text-sm font-semibold">Why it is {STATE_LABEL[invoice.state].toLowerCase()}</p>
            <ul className="space-y-1 text-sm">
              {invoice.reasons.map((r) => (
                <li key={r}>
                  <code className="font-mono text-xs">{r}</code> {reasonViews().find((v) => v.code === r)?.description}
                </li>
              ))}
            </ul>
          </Card>
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
            <div>
              <Button variant="outline" onClick={() => setEditing(true)}>
                Correct fields…
              </Button>
            </div>
          )
        )}

        <div className="space-y-3">
          <h2 className={sectionTitleClass}>Extracted fields</h2>
          {invoice.extraction ? (
            <Card className="overflow-hidden">
              <Table>
                <tbody>
                  {FIELD_LABELS.map(([key, label]) => (
                    <FieldRow key={key} label={label} field={invoice.extraction?.fields[key]} />
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : busyPipeline ? (
            <Card className="p-4 text-sm text-muted-foreground">Reading the invoice…</Card>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing was extracted from this document.</p>
          )}
          {invoice.extraction && (
            <p className="text-xs text-muted-foreground">
              Extracted by {invoice.extraction.provider}. Confidence below 80% puts the invoice on hold.
            </p>
          )}
        </div>

        {!editing && <Actions invoice={invoice} onChange={setInvoice} />}

        <div className="space-y-3">
          <h2 className={sectionTitleClass}>History</h2>
          <ol className="space-y-3 border-l border-border pl-4 text-sm">
            {(invoice.history ?? []).map((e) => (
              <li key={e.seq}>
                <span className="text-xs text-muted-foreground tabular-nums">{new Date(e.occurredAt).toLocaleString()}</span>
                <div>
                  {e.to ? (
                    <>
                      {e.from ? `${STATE_LABEL[e.from]} → ` : ''}
                      <strong>{STATE_LABEL[e.to]}</strong>
                    </>
                  ) : (
                    e.type
                  )}{' '}
                  <span className="text-xs text-muted-foreground">
                    {e.actor.kind === 'ai' ? 'AI' : e.actor.kind}: {e.actor.id}
                  </span>
                  {e.reasons && e.reasons.length > 0 && <span className="text-xs text-muted-foreground"> ({e.reasons.join(', ')})</span>}
                </div>
                {e.changes && (
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {Object.entries(e.changes).map(([field, c]) => (
                      <li key={field}>
                        {CORRECTION_LABEL[field] ?? field}: {describeValue(field, c.from, invoice.total?.currency)} →{' '}
                        {describeValue(field, c.to, invoice.total?.currency)}
                      </li>
                    ))}
                  </ul>
                )}
                {e.comment && <div className="text-xs text-muted-foreground">“{e.comment}”</div>}
              </li>
            ))}
          </ol>
        </div>

        <p className="text-sm">
          <Link href="/" className="text-primary hover:underline">
            ← Upload another
          </Link>
        </p>
      </section>
    </div>
  );
}

const MONEY_FIELDS = new Set(['total', 'subtotal', 'tax']);

function describeValue(field: string, v: unknown, currency?: string): string {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (Array.isArray(v)) return `${v.length} line${v.length === 1 ? '' : 's'}`;
  if (MONEY_FIELDS.has(field) && typeof v === 'string') return minorToInput(v, currency);
  return String(v);
}

function InvoiceDetails({ invoice }: { invoice: Invoice }) {
  const lines = invoice.lineItems ?? [];
  const currency = invoice.total?.currency;
  const money = (minor: string | undefined) => (minor !== undefined && currency ? formatMoney(minor, currency) : '—');
  if (!invoice.subtotal && !invoice.tax && !invoice.dueDate && lines.length === 0) return null;
  return (
    <div className="space-y-3">
      <h2 className={sectionTitleClass}>Details</h2>
      <Card className="overflow-hidden">
        <Table>
          <tbody>
            {invoice.invoiceDate && (
              <TableRow>
                <TableHead className="w-40 normal-case tracking-normal text-foreground">Invoice date</TableHead>
                <TableCell>{invoice.invoiceDate}</TableCell>
              </TableRow>
            )}
            {invoice.dueDate && (
              <TableRow>
                <TableHead className="w-40 normal-case tracking-normal text-foreground">Due date</TableHead>
                <TableCell>{invoice.dueDate}</TableCell>
              </TableRow>
            )}
            {invoice.subtotal && (
              <TableRow>
                <TableHead className="w-40 normal-case tracking-normal text-foreground">Subtotal</TableHead>
                <TableCell className="text-right tabular-nums">{formatMoney(invoice.subtotal.amountMinor, invoice.subtotal.currency)}</TableCell>
              </TableRow>
            )}
            {invoice.tax && (
              <TableRow>
                <TableHead className="w-40 normal-case tracking-normal text-foreground">Tax</TableHead>
                <TableCell className="text-right tabular-nums">{formatMoney(invoice.tax.amountMinor, invoice.tax.currency)}</TableCell>
              </TableRow>
            )}
          </tbody>
        </Table>
      </Card>
      {lines.length > 0 && (
        <Card className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <TableHead>#</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <TableRow key={l.position}>
                  <TableCell className="text-muted-foreground">{l.position}</TableCell>
                  <TableCell>{l.description}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.quantity ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.unitPriceMinor)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.amountMinor)}</TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

const CONFIDENCE_TONE: Record<'high' | 'medium' | 'low', string> = {
  high: 'text-emerald-700 dark:text-emerald-300',
  medium: 'text-amber-700 dark:text-amber-300',
  low: 'text-rose-700 dark:text-rose-300',
};

function FieldRow({ label, field }: { label: string; field: ExtractedField | undefined }) {
  const confidence = field?.confidence ?? 0;
  const level = confidenceLevel(confidence);
  return (
    <TableRow>
      <TableHead className="w-44 normal-case tracking-normal text-muted-foreground">{label}</TableHead>
      <TableCell>{field?.value ?? <span className="text-muted-foreground">Not on document</span>}</TableCell>
      <TableCell className="text-right">
        <span className={cn('text-xs font-medium tabular-nums', CONFIDENCE_TONE[level])} title={`confidence ${confidence}`}>
          {Math.round(confidence * 100)}%
        </span>
      </TableCell>
    </TableRow>
  );
}

function Actions({ invoice, onChange }: { invoice: Invoice; onChange: (inv: Invoice) => void }) {
  const actions = actionsFor(invoice.state);
  const me = useMe();
  const progress = approvalProgress(invoice);
  const blocker = approveBlocker(me, invoice);
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
    <Card className="space-y-4 p-5">
      <h2 className={sectionTitleClass}>Decision</h2>
      {progress && (
        <p className="text-sm">
          <strong>{progress.text}</strong> for the {invoice.approvalTier?.name} tier
          {(invoice.approvals ?? []).filter((a) => a.current).length > 0 &&
            `: approved so far by ${(invoice.approvals ?? [])
              .filter((a) => a.current)
              .map((a) => personaLabel(a.approverId))
              .join(', ')}`}
        </p>
      )}
      {actions.includes('approve') && blocker && <Notice>{blocker}</Notice>}
      <textarea
        aria-label="Decision comment"
        placeholder="Comment (optional, kept in the audit log)"
        value={comment}
        maxLength={2000}
        onChange={(e) => setComment(e.target.value)}
        className={cn(textareaClass, 'min-h-20')}
      />
      {rejecting && (
        <fieldset className="space-y-2 rounded-md border border-border p-3 text-sm">
          <legend className="px-1 text-sm font-medium">Reject because</legend>
          {REJECT_REASONS.map((r) => (
            <label key={r.code} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={reasons.includes(r.code as ReasonCode)}
                onChange={(e) => setReasons(e.target.checked ? [...reasons, r.code as ReasonCode] : reasons.filter((c) => c !== r.code))}
              />
              <code className="font-mono text-xs">{r.code}</code>
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex flex-wrap gap-2">
        {actions.includes('approve') && (
          <Button
            disabled={busy || blocker !== undefined}
            onClick={() =>
              void run(async () => {
                await approveInvoice(invoice.id, note, key.current);
                // Reload for the full history: a partial approval leaves the invoice pending.
                return getInvoice(invoice.id);
              })
            }
          >
            Approve
          </Button>
        )}
        {actions.includes('sendToApproval') && (
          <Button disabled={busy} onClick={() => void run(() => sendToApproval(invoice.id, note, key.current))}>
            Release to approval
          </Button>
        )}
        {actions.includes('reject') &&
          (rejecting ? (
            <Button
              variant="outline"
              className="border-rose-300 text-rose-700 hover:bg-rose-50 dark:text-rose-300"
              disabled={busy || reasons.length === 0}
              onClick={() => void run(() => rejectInvoice(invoice.id, reasons, note, key.current))}
            >
              Confirm rejection
            </Button>
          ) : (
            <Button variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
              Reject…
            </Button>
          ))}
      </div>
      {error && (
        <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}
