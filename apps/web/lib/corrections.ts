import type { Invoice, InvoiceCorrection, InvoiceState } from './api';
import { minorToInput, parseMoneyInput, parseQuantityInput } from './money';

/**
 * The edit-before-approve form. Values are kept as the reviewer types them;
 * buildCorrection turns them into a PATCH body holding only what changed, so
 * the audit log records the fields the reviewer actually touched. The server
 * validates again; this only catches mistakes before a round trip.
 */

export const EDITABLE: ReadonlySet<InvoiceState> = new Set<InvoiceState>(['PENDING_APPROVAL', 'HOLD', 'EXCEPTION']);

export function canCorrect(state: InvoiceState): boolean {
  return EDITABLE.has(state);
}

export interface LineForm {
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
}

export interface CorrectionForm {
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  total: string;
  subtotal: string;
  tax: string;
  lines: LineForm[];
  comment: string;
}

export type FormErrors = Partial<Record<Exclude<keyof CorrectionForm, 'lines'>, string>> & { lines?: Record<number, string> };

export function formFromInvoice(inv: Invoice): CorrectionForm {
  return {
    vendorName: inv.vendorName ?? '',
    invoiceNumber: inv.invoiceNumber ?? '',
    invoiceDate: inv.invoiceDate ?? '',
    dueDate: inv.dueDate ?? '',
    currency: inv.total?.currency ?? inv.extraction?.fields.currency.value ?? '',
    total: minorToInput(inv.total?.amountMinor),
    subtotal: minorToInput(inv.subtotal?.amountMinor),
    tax: minorToInput(inv.tax?.amountMinor),
    lines: (inv.lineItems ?? []).map((l) => ({
      description: l.description,
      quantity: l.quantity ?? '',
      unitPrice: minorToInput(l.unitPriceMinor),
      amount: minorToInput(l.amountMinor),
    })),
    comment: '',
  };
}

export const EMPTY_LINE: LineForm = { description: '', quantity: '', unitPrice: '', amount: '' };

type LineBody = NonNullable<InvoiceCorrection['lineItems']>[number];

function lineBody(l: LineForm, i: number, errors: Record<number, string>): LineBody | undefined {
  const description = l.description.trim();
  if (!description) {
    errors[i] = 'Every line needs a description';
    return undefined;
  }
  const out: { description: string; quantity?: string; unitPriceMinor?: string; amountMinor?: string } = { description };
  if (l.quantity.trim()) {
    const q = parseQuantityInput(l.quantity);
    if (!q.ok) {
      errors[i] = q.error;
      return undefined;
    }
    out.quantity = q.quantity;
  }
  for (const [field, key] of [
    ['unitPrice', 'unitPriceMinor'],
    ['amount', 'amountMinor'],
  ] as const) {
    if (!l[field].trim()) continue;
    const m = parseMoneyInput(l[field]);
    if (!m.ok) {
      errors[i] = m.error;
      return undefined;
    }
    out[key] = m.minor;
  }
  return out;
}

function normalizeQty(q: string | undefined): string | undefined {
  if (q === undefined) return undefined;
  const [w = '0', f = ''] = q.split('.');
  const frac = f.replace(/0+$/, '');
  const whole = w.replace(/^0+(?=\d)/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function sameLines(a: readonly LineBody[], b: NonNullable<Invoice['lineItems']>): boolean {
  if (a.length !== b.length) return false;
  return a.every((l, i) => {
    const o = b[i];
    return (
      o !== undefined &&
      l.description === o.description &&
      normalizeQty(l.quantity) === normalizeQty(o.quantity) &&
      l.unitPriceMinor === o.unitPriceMinor &&
      l.amountMinor === o.amountMinor
    );
  });
}

export type BuildResult = { ok: true; body: InvoiceCorrection; changed: string[] } | { ok: false; errors: FormErrors };

export function buildCorrection(inv: Invoice, form: CorrectionForm): BuildResult {
  const errors: FormErrors = {};
  const body: Record<string, unknown> = { expectedVersion: inv.version };
  const changed: string[] = [];
  const set = (key: string, label: string, value: unknown, before: unknown) => {
    if (value === before) return;
    body[key] = value;
    changed.push(label);
  };

  const vendor = form.vendorName.trim();
  if (!vendor) errors.vendorName = 'Vendor is required';
  else if (vendor.length > 256) errors.vendorName = 'At most 256 characters';
  else set('vendorName', 'vendorName', vendor, inv.vendorName);

  const number = form.invoiceNumber.trim();
  if (!number) errors.invoiceNumber = 'Invoice number is required';
  else if (number.length > 64) errors.invoiceNumber = 'At most 64 characters';
  else set('invoiceNumber', 'invoiceNumber', number, inv.invoiceNumber);

  if (!form.invoiceDate) errors.invoiceDate = 'Invoice date is required';
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(form.invoiceDate)) errors.invoiceDate = 'Use YYYY-MM-DD';
  else set('invoiceDate', 'invoiceDate', form.invoiceDate, inv.invoiceDate);

  if (form.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(form.dueDate)) errors.dueDate = 'Use YYYY-MM-DD';
  else if (form.dueDate && form.invoiceDate && form.dueDate < form.invoiceDate) errors.dueDate = 'Due date is before the invoice date';
  else set('dueDate', 'dueDate', form.dueDate || null, inv.dueDate ?? null);

  const currency = form.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) errors.currency = 'A 3-letter code like USD';
  else set('currency', 'currency', currency, inv.total?.currency);

  const total = parseMoneyInput(form.total);
  if (!total.ok) errors.total = total.error;
  else set('totalMinor', 'total', total.minor, inv.total?.amountMinor);

  for (const [field, key, before] of [
    ['subtotal', 'subtotalMinor', inv.subtotal?.amountMinor ?? null],
    ['tax', 'taxMinor', inv.tax?.amountMinor ?? null],
  ] as const) {
    if (!form[field].trim()) {
      set(key, field, null, before);
      continue;
    }
    const m = parseMoneyInput(form[field]);
    if (!m.ok) errors[field] = m.error;
    else set(key, field, m.minor, before);
  }

  const lineErrors: Record<number, string> = {};
  const lines = form.lines.map((l, i) => lineBody(l, i, lineErrors));
  if (Object.keys(lineErrors).length > 0) errors.lines = lineErrors;
  else if (form.lines.length > 200) errors.lines = { 200: 'At most 200 lines' };
  else if (!sameLines(lines as LineBody[], inv.lineItems ?? [])) {
    body['lineItems'] = lines;
    changed.push('lineItems');
  }

  if (form.comment.trim()) body['comment'] = form.comment.trim().slice(0, 2000);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: body as unknown as InvoiceCorrection, changed };
}

/** Sum of the line amounts in minor units, or undefined when any line has no amount. */
export function linesSum(lines: readonly LineForm[]): string | undefined {
  let sum = 0n;
  for (const l of lines) {
    const m = parseMoneyInput(l.amount);
    if (!m.ok) return undefined;
    sum += BigInt(m.minor);
  }
  return sum.toString();
}

/** What the form's numbers imply, for a live "does it add up" hint. */
export function arithmeticHint(form: CorrectionForm): string | undefined {
  const total = parseMoneyInput(form.total);
  if (!total.ok) return undefined;
  const tax = form.tax.trim() ? parseMoneyInput(form.tax) : { ok: true as const, minor: '0' };
  if (!tax.ok) return undefined;
  if (form.subtotal.trim()) {
    const sub = parseMoneyInput(form.subtotal);
    if (sub.ok && BigInt(sub.minor) + BigInt(tax.minor) !== BigInt(total.minor)) {
      return `Subtotal + tax is ${minorToInput((BigInt(sub.minor) + BigInt(tax.minor)).toString())}, not ${minorToInput(total.minor)}`;
    }
  }
  const sum = form.lines.length > 0 ? linesSum(form.lines) : undefined;
  if (sum !== undefined && BigInt(sum) + BigInt(tax.minor) !== BigInt(total.minor)) {
    return `Lines + tax is ${minorToInput((BigInt(sum) + BigInt(tax.minor)).toString())}, not ${minorToInput(total.minor)}`;
  }
  return undefined;
}
