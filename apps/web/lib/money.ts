/**
 * Money typed by a person, to and from integer minor units, without floats.
 * Like the rest of the app this assumes two-decimal currencies (see format.ts).
 */

export type Parsed = { ok: true; minor: string } | { ok: false; error: string };

/** "1,234.5" -> "123450". Accepts thousands separators, an optional minus sign and up to two decimals. */
export function parseMoneyInput(raw: string): Parsed {
  const s = raw.trim().replace(/\s+/g, '');
  if (!s) return { ok: false, error: 'Enter an amount' };
  const m = /^(-)?((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return { ok: false, error: 'Use digits with up to two decimals, like 1,234.50' };
  const [, sign, whole = '0', frac = ''] = m;
  const digits = `${whole.replace(/,/g, '')}${frac.padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  if (digits.length > 18) return { ok: false, error: 'That amount is too large' };
  return { ok: true, minor: sign && digits !== '0' ? `-${digits}` : digits };
}

/** "123450" -> "1234.50", the inverse of parseMoneyInput for pre-filling a form. */
export function minorToInput(minor: string | undefined | null): string {
  if (minor === undefined || minor === null || minor === '') return '';
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(3, '0');
  return `${neg ? '-' : ''}${digits.slice(0, -2).replace(/^0+(?=\d)/, '')}.${digits.slice(-2)}`;
}

/** Quantity as the API wants it: a plain decimal, at most 4 places, no sign. */
export function parseQuantityInput(raw: string): { ok: true; quantity: string } | { ok: false; error: string } {
  const s = raw.trim();
  if (!/^\d{1,12}(\.\d{1,4})?$/.test(s)) return { ok: false, error: 'Quantity is a number with up to 4 decimals' };
  return { ok: true, quantity: s };
}
