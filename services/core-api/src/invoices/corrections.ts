import type { InvoiceState } from '../domain/index.js';
import { HttpProblem } from '../http/problem.js';
import { isCalendarDate } from './filters.js';
import type { HeaderUpdate, InvoiceRow, LineItemInput, LineItemRow } from './store.js';

/**
 * Edit-before-approve. A reviewer may correct what extraction got wrong while
 * the invoice waits on a human (PENDING_APPROVAL, HOLD or EXCEPTION). This
 * module is pure: it validates a correction against the current row and says
 * exactly what changes. The service applies it, audits the before/after and
 * sends the invoice back through validation.
 */

export const EDITABLE_STATES: ReadonlySet<InvoiceState> = new Set<InvoiceState>(['PENDING_APPROVAL', 'HOLD', 'EXCEPTION']);

export const CORRECTABLE_FIELDS = [
  'vendorName',
  'invoiceNumber',
  'invoiceDate',
  'dueDate',
  'currency',
  'total',
  'subtotal',
  'tax',
  'lineItems',
] as const;
export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

export const MAX_LINE_ITEMS = 200;

export interface LineItemBody {
  readonly description: string;
  readonly quantity?: string;
  readonly unitPriceMinor?: string;
  readonly amountMinor?: string;
}

export interface CorrectionInput {
  readonly expectedVersion: number;
  readonly vendorName?: string;
  readonly invoiceNumber?: string;
  readonly invoiceDate?: string;
  readonly dueDate?: string | null;
  readonly currency?: string;
  readonly totalMinor?: string;
  readonly subtotalMinor?: string | null;
  readonly taxMinor?: string | null;
  readonly lineItems?: readonly LineItemBody[];
  readonly comment?: string;
}

export type FieldChanges = Partial<Record<CorrectableField, { from: unknown; to: unknown }>>;

export interface CorrectionPlan {
  readonly changes: FieldChanges;
  readonly update: HeaderUpdate;
  /** Present when the lines change; replaces every line. */
  readonly lines?: readonly LineItemInput[];
}

/** JSON schema for the request body, mirroring InvoiceCorrection in the contract. */
const MINOR = { type: 'string', pattern: '^-?[0-9]{1,18}$' } as const;
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
// type: [string, null] rather than anyOf, so Fastify's type coercion never turns null into "".
const NULLABLE_MINOR = { type: ['string', 'null'], pattern: '^-?[0-9]{1,18}$' } as const;
const NULLABLE_DATE = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
export const CORRECTION_BODY_SCHEMA = {
  type: 'object',
  required: ['expectedVersion'],
  minProperties: 2,
  additionalProperties: false,
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
    vendorName: { type: 'string', minLength: 1, maxLength: 256 },
    invoiceNumber: { type: 'string', minLength: 1, maxLength: 64 },
    invoiceDate: DATE,
    dueDate: NULLABLE_DATE,
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    totalMinor: MINOR,
    subtotalMinor: NULLABLE_MINOR,
    taxMinor: NULLABLE_MINOR,
    lineItems: {
      type: 'array',
      maxItems: MAX_LINE_ITEMS,
      items: {
        type: 'object',
        required: ['description'],
        additionalProperties: false,
        properties: {
          description: { type: 'string', minLength: 1, maxLength: 500 },
          quantity: { type: 'string', pattern: '^[0-9]{1,12}(\\.[0-9]{1,4})?$' },
          unitPriceMinor: MINOR,
          amountMinor: MINOR,
        },
      },
    },
    comment: { type: 'string', maxLength: 2000 },
  },
} as const;

function invalid(detail: string, code = 'INVALID_CORRECTION'): HttpProblem {
  return new HttpProblem(422, 'Invalid correction', detail, code);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function cleanText(field: string, value: string, max: number): string {
  const v = value.trim();
  if (!v) throw invalid(`${field} cannot be blank`);
  if (v.length > max) throw invalid(`${field} is at most ${max} characters`);
  if (CONTROL.test(v)) throw invalid(`${field} cannot contain control characters`);
  return v;
}

function cleanDate(field: string, value: string): string {
  if (!isCalendarDate(value)) throw invalid(`${field} must be a real date as YYYY-MM-DD`);
  return value;
}

function cleanMinor(field: string, value: string): string {
  if (!/^-?[0-9]{1,18}$/.test(value)) throw invalid(`${field} must be an integer number of minor units`);
  // Canonical form: no leading zeros, no "-0".
  const n = BigInt(value);
  return n.toString();
}

/** "2.500" and "2.5" are the same quantity; store and compare the shortest form. */
export function normalizeQuantity(q: string): string {
  if (!/^[0-9]{1,12}(\.[0-9]{1,4})?$/.test(q)) throw invalid(`quantity ${q} must be a decimal with at most 4 places`);
  const [whole = '0', frac = ''] = q.split('.');
  const w = whole.replace(/^0+(?=\d)/, '');
  const f = frac.replace(/0+$/, '');
  return f ? `${w}.${f}` : w;
}

export function cleanLines(lines: readonly LineItemBody[]): LineItemInput[] {
  if (lines.length > MAX_LINE_ITEMS) throw invalid(`at most ${MAX_LINE_ITEMS} line items`);
  return lines.map((l, i) => ({
    description: cleanText(`lineItems[${i}].description`, l.description, 500),
    quantity: l.quantity === undefined ? null : normalizeQuantity(l.quantity),
    unitPriceMinor: l.unitPriceMinor === undefined ? null : cleanMinor(`lineItems[${i}].unitPriceMinor`, l.unitPriceMinor),
    amountMinor: l.amountMinor === undefined ? null : cleanMinor(`lineItems[${i}].amountMinor`, l.amountMinor),
  }));
}

function linesOf(rows: readonly LineItemRow[]): LineItemInput[] {
  return rows.map((r) => ({ description: r.description, quantity: r.quantity, unitPriceMinor: r.unit_price_minor, amountMinor: r.amount_minor }));
}

function sameLines(a: readonly LineItemInput[], b: readonly LineItemInput[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Check the state and version, validate the input and work out what actually changes. */
export function planCorrection(row: InvoiceRow, currentLines: readonly LineItemRow[], input: CorrectionInput): CorrectionPlan {
  if (!EDITABLE_STATES.has(row.state)) {
    throw new HttpProblem(
      409,
      'Not editable',
      `only invoices waiting on a reviewer (PENDING_APPROVAL, HOLD, EXCEPTION) can be corrected; this one is ${row.state}`,
      'NOT_EDITABLE',
    );
  }
  if (input.expectedVersion !== row.version) {
    throw new HttpProblem(
      409,
      'Version conflict',
      `the invoice is at version ${row.version}, not ${input.expectedVersion}; reload it and correct again`,
      'VERSION_CONFLICT',
    );
  }

  const changes: FieldChanges = {};
  const update: HeaderUpdate = {};
  const note = <T>(field: CorrectableField, from: T, to: T): boolean => {
    if (from === to) return false;
    changes[field] = { from, to };
    return true;
  };

  if (input.vendorName !== undefined) {
    const v = cleanText('vendorName', input.vendorName, 256);
    if (note('vendorName', row.vendor_name, v)) update.vendor_name = v;
  }
  if (input.invoiceNumber !== undefined) {
    const v = cleanText('invoiceNumber', input.invoiceNumber, 64);
    if (note('invoiceNumber', row.invoice_number, v)) update.invoice_number = v;
  }
  if (input.invoiceDate !== undefined) {
    const v = cleanDate('invoiceDate', input.invoiceDate);
    if (note('invoiceDate', row.invoice_date, v)) update.invoice_date = v;
  }
  if (input.dueDate !== undefined) {
    const v = input.dueDate === null ? null : cleanDate('dueDate', input.dueDate);
    if (note('dueDate', row.due_date, v)) update.due_date = v;
  }
  if (input.currency !== undefined) {
    if (!/^[A-Z]{3}$/.test(input.currency)) throw invalid('currency must be an ISO 4217 code such as USD');
    if (note('currency', row.currency, input.currency)) update.currency = input.currency;
  }
  if (input.totalMinor !== undefined) {
    const v = cleanMinor('totalMinor', input.totalMinor);
    if (note('total', row.total_minor, v)) update.total_minor = v;
  }
  if (input.subtotalMinor !== undefined) {
    const v = input.subtotalMinor === null ? null : cleanMinor('subtotalMinor', input.subtotalMinor);
    if (note('subtotal', row.subtotal_minor, v)) update.subtotal_minor = v;
  }
  if (input.taxMinor !== undefined) {
    const v = input.taxMinor === null ? null : cleanMinor('taxMinor', input.taxMinor);
    if (note('tax', row.tax_minor, v)) update.tax_minor = v;
  }

  let lines: LineItemInput[] | undefined;
  if (input.lineItems !== undefined) {
    const next = cleanLines(input.lineItems);
    const prev = linesOf(currentLines);
    if (!sameLines(prev, next)) {
      changes.lineItems = { from: prev, to: next };
      lines = next;
    }
  }

  const invoiceDate = update.invoice_date ?? row.invoice_date;
  const dueDate = 'due_date' in update ? update.due_date : row.due_date;
  if (invoiceDate && dueDate && dueDate < invoiceDate) {
    throw invalid(`the due date ${dueDate} is before the invoice date ${invoiceDate}`, 'DUE_BEFORE_INVOICE_DATE');
  }

  if (Object.keys(changes).length === 0) {
    throw invalid('the correction changes nothing; every value equals what is stored', 'NO_CHANGES');
  }
  return { changes, update, ...(lines ? { lines } : {}) };
}
