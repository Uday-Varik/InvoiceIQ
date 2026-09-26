import catalog from '@invoiceiq/contracts/catalog/reason-codes.json' with { type: 'json' };

/**
 * Money typed by a person, to and from integer minor units, without floats.
 * Each currency uses its own ISO 4217 decimal places (2 for USD, 0 for JPY,
 * 3 for BHD), read from the catalog core-api exports.
 */

const EXPONENTS = catalog.currencyExponents as Record<string, number>;

/** Decimal places of `currency`'s minor unit; 2 when unknown or not yet chosen. */
export function currencyExponent(currency?: string | null): number {
  const code = currency?.trim().toUpperCase();
  return (code ? EXPONENTS[code] : undefined) ?? EXPONENTS['default'] ?? 2;
}

export type Parsed = { ok: true; minor: string } | { ok: false; error: string };

/**
 * "1,234.5" -> "123450" for USD, "12,000" -> "12000" for JPY. Accepts
 * thousands separators, an optional minus sign and up to the currency's
 * decimal places.
 */
export function parseMoneyInput(raw: string, currency?: string | null): Parsed {
  const e = currencyExponent(currency);
  const s = raw.trim().replace(/\s+/g, '');
  if (!s) return { ok: false, error: 'Enter an amount' };
  const m = /^(-)?((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d+))?$/.exec(s);
  const [, sign, whole = '0', frac = ''] = m ?? [];
  if (!m || frac.length > e || (e === 0 && m[3] !== undefined)) {
    return { ok: false, error: e === 0 ? 'Use whole numbers, like 12,000' : `Use digits with up to ${e} decimals, like ${example(e)}` };
  }
  const digits = `${whole.replace(/,/g, '')}${frac.padEnd(e, '0')}`.replace(/^0+(?=\d)/, '');
  if (digits.length > 18) return { ok: false, error: 'That amount is too large' };
  return { ok: true, minor: sign && digits !== '0' ? `-${digits}` : digits };
}

function example(e: number): string {
  return `1,234.${'5'.padEnd(e, '0')}`;
}

/** "123450" -> "1234.50" for USD, "12000" -> "12000" for JPY: the inverse of parseMoneyInput. */
export function minorToInput(minor: string | undefined | null, currency?: string | null): string {
  if (minor === undefined || minor === null || minor === '') return '';
  const e = currencyExponent(currency);
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(e + 1, '0');
  if (e === 0) return `${neg ? '-' : ''}${digits.replace(/^0+(?=\d)/, '')}`;
  return `${neg ? '-' : ''}${digits.slice(0, -e).replace(/^0+(?=\d)/, '')}.${digits.slice(-e)}`;
}

/** Quantity as the API wants it: a plain decimal, at most 4 places, no sign. */
export function parseQuantityInput(raw: string): { ok: true; quantity: string } | { ok: false; error: string } {
  const s = raw.trim();
  if (!/^\d{1,12}(\.\d{1,4})?$/.test(s)) return { ok: false, error: 'Quantity is a number with up to 4 decimals' };
  return { ok: true, quantity: s };
}
