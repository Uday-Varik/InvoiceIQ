/**
 * ISO 4217 minor-unit exponents: how many decimal places a currency's minor
 * unit has. Most currencies have 2 and are left out; this lists the rest. The
 * table is exported to packages/contracts/catalog/reason-codes.json, and
 * guardrails check that ai-service and the web app carry the same one.
 */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
});

export const DEFAULT_EXPONENT = 2;

/** Decimal places of `currency`'s minor unit (2 unless listed). */
export function currencyExponent(currency: string | null | undefined): number {
  return (currency ? CURRENCY_EXPONENTS[currency] : undefined) ?? DEFAULT_EXPONENT;
}

/**
 * Integer minor units as a plain decimal string in major units, without a
 * float: ("123450", "USD") -> "1234.50", ("1200", "JPY") -> "1200",
 * ("1500", "BHD") -> "1.500".
 */
export function minorToDecimal(minor: bigint | string, currency: string | null | undefined): string {
  const text = typeof minor === 'bigint' ? minor.toString() : minor;
  if (!/^-?\d+$/.test(text)) throw new RangeError(`not an integer amount: ${text}`);
  const e = currencyExponent(currency);
  const neg = text.startsWith('-');
  const digits = (neg ? text.slice(1) : text).replace(/^0+(?=\d)/, '');
  const sign = neg && /[1-9]/.test(digits) ? '-' : '';
  if (e === 0) return `${sign}${digits}`;
  const padded = digits.padStart(e + 1, '0');
  return `${sign}${padded.slice(0, -e)}.${padded.slice(-e)}`;
}
