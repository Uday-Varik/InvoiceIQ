import { approvalTierFor, parsePolicy, type Actor, type Policy, type ReasonCode } from '../domain/index.js';
import { withTenant, type Db, type Tx } from '../db/pool.js';
import { AiRejectedError, type AiClient, type ExtractionResult } from '../clients/ai-service.js';
import { appendAudit } from './audit.js';
import { transition } from './lifecycle.js';
import {
  getDocument,
  getInvoice,
  getLineItems,
  headerOf,
  replaceLineItems,
  saveExtraction,
  type ExtractedHeader,
  type InvoiceRow,
  type LineItemInput,
  type StoredExtraction,
} from './store.js';

/**
 * RECEIVED -> EXTRACTING -> EXTRACTED -> (HOLD | VALIDATING -> VALIDATED | EXCEPTION)
 *   -> MATCHING -> MATCHED -> (HOLD | PENDING_APPROVAL)
 *
 * Every step is re-entrant: the handler looks at the current state and only
 * does what is left, so an outbox retry after a crash or a cold ai-service
 * picks up where it stopped. The ai-service call happens outside any
 * transaction so a slow model never holds a row lock.
 */

export const PIPELINE_ACTOR: Actor = { kind: 'system', id: 'core-api:pipeline' };
export const AI_ACTOR: Actor = { kind: 'ai', id: 'ai-service' };
const REQUIRED_FIELDS = ['vendorName', 'invoiceNumber', 'currency', 'totalMinor'] as const;

export interface PipelineDeps {
  readonly db: Db;
  readonly ai: AiClient;
}

export async function loadPolicy(tx: Tx): Promise<Policy> {
  const { rows } = await tx.query<{ policy: unknown }>('SELECT policy FROM tenant_policies WHERE tenant_id = app_tenant()');
  if (!rows[0]) throw new Error('tenant has no policy; run the tenant bootstrap');
  return parsePolicy(rows[0].policy);
}

const MAX_BIGINT = 2n ** 63n - 1n;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const QUANTITY_RE = /^[0-9]{1,12}(\.[0-9]{1,4})?$/;

function minor(v: string | null | undefined): bigint | null {
  if (!v || !/^-?\d{1,19}$/.test(v)) return null;
  const n = BigInt(v);
  return n <= MAX_BIGINT && n >= -MAX_BIGINT ? n : null;
}

function isoDate(v: string | null | undefined): string | null {
  return v && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** Only well-formed values reach typed columns; everything else stays in the raw extraction. */
export function headerFrom(extraction: ExtractionResult): ExtractedHeader {
  const f = extraction.fields;
  const text = (v: string | null, max: number) => {
    const t = v?.trim();
    return t && t.length <= max ? t : null;
  };
  const currency = f.currency.value && /^[A-Z]{3}$/.test(f.currency.value) ? f.currency.value : null;
  return {
    vendorName: text(f.vendorName.value, 256),
    invoiceNumber: text(f.invoiceNumber.value, 64),
    invoiceDate: isoDate(f.invoiceDate.value),
    currency,
    totalMinor: minor(f.totalMinor.value),
    subtotalMinor: minor(f.subtotalMinor.value),
    taxMinor: minor(f.taxMinor.value),
    dueDate: isoDate(f.dueDate.value),
  };
}

/** Extracted lines that fit the table; a malformed number is stored as unknown rather than guessed. */
export function linesFrom(extraction: ExtractionResult): LineItemInput[] {
  return extraction.lineItems.slice(0, 200).flatMap((l) => {
    const description = l.description.trim().slice(0, 500);
    if (!description) return [];
    const quantity = l.quantity !== null && QUANTITY_RE.test(l.quantity) ? l.quantity : null;
    const unit = minor(l.unitPriceMinor);
    const amount = minor(l.amountMinor);
    return [{ description, quantity, unitPriceMinor: unit === null ? null : unit.toString(), amountMinor: amount === null ? null : amount.toString() }];
  });
}

export interface TotalsFinding {
  readonly check: 'subtotal_plus_tax' | 'lines_plus_tax';
  readonly expectedTotalMinor: string;
  readonly totalMinor: string;
}

/**
 * The arithmetic an invoice prints must hold exactly, to the minor unit:
 * subtotal + tax = total, and when every line has an amount, the lines add up
 * to the subtotal (or, with no subtotal, to total - tax).
 */
export function checkTotals(header: ExtractedHeader, lines: readonly LineItemInput[]): TotalsFinding[] {
  const total = header.totalMinor;
  if (total === null) return [];
  const tax = header.taxMinor ?? 0n;
  const findings: TotalsFinding[] = [];
  if (header.subtotalMinor !== null && header.subtotalMinor + tax !== total) {
    findings.push({ check: 'subtotal_plus_tax', expectedTotalMinor: (header.subtotalMinor + tax).toString(), totalMinor: total.toString() });
  }
  if (lines.length > 0 && lines.every((l) => l.amountMinor !== null)) {
    const sum = lines.reduce((acc, l) => acc + BigInt(l.amountMinor as string), 0n);
    if (sum + tax !== total) {
      findings.push({ check: 'lines_plus_tax', expectedTotalMinor: (sum + tax).toString(), totalMinor: total.toString() });
    }
  }
  return findings;
}

async function startExtraction(db: Db, tenantId: string, invoiceId: string): Promise<InvoiceRow | undefined> {
  return withTenant(db, tenantId, async (tx) => {
    const inv = await getInvoice(tx, invoiceId, { forUpdate: true });
    if (!inv) return undefined;
    if (inv.state === 'RECEIVED') return transition(tx, inv, { to: 'EXTRACTING', actor: PIPELINE_ACTOR });
    return inv.state === 'EXTRACTING' ? inv : undefined;
  });
}

/** Handler for invoice.received. Throws AiUnavailableError to ask the outbox for a retry. */
export async function processReceived(deps: PipelineDeps, tenantId: string, invoiceId: string): Promise<void> {
  const inv = await startExtraction(deps.db, tenantId, invoiceId);
  if (!inv) return; // already past extraction: nothing left to do

  const { doc, threshold } = await withTenant(deps.db, tenantId, async (tx) => ({
    doc: await getDocument(tx, inv.document_sha256),
    threshold: (await loadPolicy(tx)).ai.extractionConfidenceHoldBelow,
  }));
  if (!doc) throw new Error(`document ${inv.document_sha256} missing for invoice ${invoiceId}`);

  let extraction: ExtractionResult;
  let signals: Awaited<ReturnType<AiClient['signals']>>['signals'];
  try {
    extraction = await deps.ai.extractDocument({
      tenantId,
      documentSha256: inv.document_sha256,
      contentType: doc.contentType,
      content: doc.content,
    });
    ({ signals } = await deps.ai.signals({ extraction, extractionConfidenceHoldBelow: threshold }));
  } catch (err) {
    if (err instanceof AiRejectedError) {
      await holdForManualReview(deps.db, tenantId, invoiceId, 'document_unreadable', err.message);
      return;
    }
    throw err;
  }

  await withTenant(deps.db, tenantId, async (tx) => {
    let cur = await getInvoice(tx, invoiceId, { forUpdate: true });
    if (!cur || cur.state !== 'EXTRACTING') return;
    const stored: StoredExtraction = { ...extraction, extractedAt: new Date().toISOString() };
    const header = headerFrom(extraction);
    const lines = linesFrom(extraction);
    await saveExtraction(tx, invoiceId, header, stored);
    await replaceLineItems(tx, tenantId, invoiceId, lines);
    await appendAudit(tx, {
      tenantId,
      invoiceId,
      type: 'invoice.extracted',
      actor: AI_ACTOR,
      payload: { provider: extraction.provider, fields: extraction.fields, lineItems: extraction.lineItems.length },
    });
    cur = await transition(tx, cur, { to: 'EXTRACTED', actor: PIPELINE_ACTOR });

    if (signals.length > 0) {
      // AI can only ever hold. The gate enforces it; this is just the only thing we ask for.
      await transition(tx, cur, {
        to: 'HOLD',
        actor: AI_ACTOR,
        reasons: signals.map((s) => s.reasonCode),
        details: { signals },
      });
      return;
    }
    cur = await transition(tx, cur, { to: 'VALIDATING', actor: PIPELINE_ACTOR });
    await routeFromValidating(tx, cur, header, lines, await loadPolicy(tx));
  });
}

/**
 * Re-run validation, matching and routing for an invoice a human just sent
 * back to VALIDATING (after correcting it, or from the transitions endpoint).
 * Reads the row as it is now, so human corrections are what gets validated.
 */
export async function continueFromValidating(tx: Tx, invoice: InvoiceRow): Promise<InvoiceRow> {
  if (invoice.state !== 'VALIDATING') return invoice;
  const lines = (await getLineItems(tx, invoice.id)).map((l) => ({
    description: l.description,
    quantity: l.quantity,
    unitPriceMinor: l.unit_price_minor,
    amountMinor: l.amount_minor,
  }));
  return routeFromValidating(tx, invoice, headerOf(invoice), lines, await loadPolicy(tx));
}

async function routeFromValidating(
  tx: Tx,
  invoice: InvoiceRow,
  header: ExtractedHeader,
  lines: readonly LineItemInput[],
  policy: Policy,
): Promise<InvoiceRow> {
  let cur = invoice;
  const missing = REQUIRED_FIELDS.filter((k) => header[k] === null);
  const reasons: ReasonCode[] = [];
  if (missing.length > 0) reasons.push('VALIDATION_MISSING_FIELD');
  if (header.currency !== null && !policy.enabledCurrencies.includes(header.currency)) reasons.push('VALIDATION_CURRENCY_UNSUPPORTED');
  const totals = checkTotals(header, lines);
  if (totals.length > 0) reasons.push('VALIDATION_TOTALS_MISMATCH');
  if (reasons.length > 0) {
    return transition(tx, cur, {
      to: 'EXCEPTION',
      actor: PIPELINE_ACTOR,
      reasons,
      details: { missing, currency: header.currency, ...(totals.length > 0 ? { totals } : {}) },
    });
  }
  cur = await transition(tx, cur, { to: 'VALIDATED', actor: PIPELINE_ACTOR });

  // Phase 1 has no purchase orders or receipts yet, so every invoice is a non-PO
  // invoice and matching records that explicitly. Two- and three-way matching
  // (domain/matching.ts) is wired in once POs exist.
  cur = await transition(tx, cur, { to: 'MATCHING', actor: PIPELINE_ACTOR });
  cur = await transition(tx, cur, { to: 'MATCHED', actor: PIPELINE_ACTOR, details: { mode: 'non_po' } });

  const total = header.totalMinor ?? 0n;
  if (approvalTierFor(policy, total) === undefined) {
    return transition(tx, cur, { to: 'HOLD', actor: PIPELINE_ACTOR, reasons: ['APPROVAL_LIMIT_EXCEEDED'], details: { totalMinor: total.toString() } });
  }
  const manualAt = policy.manualReview.amountAtLeastMinor;
  if (manualAt !== undefined && total >= manualAt) {
    return transition(tx, cur, { to: 'HOLD', actor: PIPELINE_ACTOR, reasons: ['POLICY_MANUAL_REVIEW_REQUIRED'], details: { cause: 'amount' } });
  }
  return transition(tx, cur, { to: 'PENDING_APPROVAL', actor: PIPELINE_ACTOR });
}

/** Extraction could not happen (unreadable document, or ai-service down past the retry budget). */
export async function holdForManualReview(db: Db, tenantId: string, invoiceId: string, cause: string, error: string): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    const cur = await getInvoice(tx, invoiceId, { forUpdate: true });
    if (!cur || cur.state !== 'EXTRACTING') return;
    await transition(tx, cur, {
      to: 'HOLD',
      actor: PIPELINE_ACTOR,
      reasons: ['POLICY_MANUAL_REVIEW_REQUIRED'],
      details: { cause, error: error.slice(0, 500) },
    });
  });
}
