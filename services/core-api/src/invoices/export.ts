import { minorToDecimal } from '../domain/index.js';
import type { InvoiceRow } from './store.js';

/**
 * CSV export. One row per invoice, RFC 4180 quoting, CRLF line ends and a
 * UTF-8 BOM so spreadsheet apps read non-ASCII vendor names correctly.
 *
 * Cells are defended against formula injection (CWE-1236): an extracted
 * vendor name like `=HYPERLINK(...)` comes from an untrusted document, so any
 * text cell starting with = + - @ tab or CR is prefixed with a single quote.
 * Numeric columns are written by this code, never from document text, so
 * negative amounts keep their minus sign.
 */

export const CSV_COLUMNS = [
  'id',
  'state',
  'reasons',
  'vendor_name',
  'invoice_number',
  'invoice_date',
  'due_date',
  'currency',
  'subtotal',
  'tax',
  'total',
  'total_minor',
  'line_items',
  'corrected_fields',
  'source_channel',
  'document_filename',
  'created_at',
  'updated_at',
] as const;

const FORMULA_START = /^[=+\-@\t\r]/;

/** A text cell as CSV: neutralise formulas, then quote when needed. */
export function csvText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return csvQuote(safe);
}

export function csvQuote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Integer minor units as a decimal string in the currency's own decimal places
 * ("-1234.50" for USD, "1200" for JPY), without going through a float.
 */
export function formatMinor(minor: string | null, currency: string | null): string {
  return minor === null ? '' : minorToDecimal(minor, currency);
}

export function csvRow(row: InvoiceRow, lineCount: number): string {
  const cells: string[] = [
    row.id,
    row.state,
    csvText(row.reasons.join(';')),
    csvText(row.vendor_name),
    csvText(row.invoice_number),
    row.invoice_date ?? '',
    row.due_date ?? '',
    row.currency ?? '',
    formatMinor(row.subtotal_minor, row.currency),
    formatMinor(row.tax_minor, row.currency),
    formatMinor(row.total_minor, row.currency),
    row.total_minor ?? '',
    String(lineCount),
    csvText(row.corrected_fields.join(';')),
    row.source_channel,
    csvText(row.document_filename),
    row.created_at.toISOString(),
    row.updated_at.toISOString(),
  ];
  return cells.join(',');
}

export function toCsv(rows: readonly InvoiceRow[], lineCounts: ReadonlyMap<string, number> = new Map()): string {
  const lines = [CSV_COLUMNS.join(','), ...rows.map((r) => csvRow(r, lineCounts.get(r.id) ?? 0))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** `invoices-2026-09-25.csv`: the day the export ran, UTC. */
export function exportFilename(format: 'csv' | 'json', now: Date = new Date()): string {
  return `invoices-${now.toISOString().slice(0, 10)}.${format}`;
}
