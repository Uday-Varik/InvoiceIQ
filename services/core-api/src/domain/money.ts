import { minorToDecimal } from './currency.js';

/**
 * Money is always an integer count of minor units plus an ISO 4217 code. The
 * minor unit is the currency's own (cents for USD, yen for JPY, fils for BHD).
 * Floats never touch amounts. See docs/architecture/domain-model.md.
 */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: string;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

export function money(amountMinor: bigint | number, currency: string): Money {
  if (!CURRENCY_RE.test(currency)) {
    throw new RangeError(`invalid ISO 4217 currency code: ${currency}`);
  }
  if (typeof amountMinor === 'number' && !Number.isSafeInteger(amountMinor)) {
    throw new RangeError(`amountMinor must be a safe integer, got ${amountMinor}`);
  }
  return { amountMinor: BigInt(amountMinor), currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function sum(items: readonly Money[], currency: string): Money {
  return items.reduce((acc, m) => add(acc, m), money(0n, currency));
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function abs(a: Money): Money {
  return { amountMinor: a.amountMinor < 0n ? -a.amountMinor : a.amountMinor, currency: a.currency };
}

/** Multiply by a quantity expressed in thousandths (qty 1.5 => 1500), rounding half away from zero. */
export function multiplyByMilli(a: Money, quantityMilli: bigint): Money {
  const raw = a.amountMinor * quantityMilli;
  const q = raw / 1000n;
  const r = raw % 1000n;
  const absR = r < 0n ? -r : r;
  const rounded = absR * 2n >= 1000n ? q + (raw < 0n ? -1n : 1n) : q;
  return { amountMinor: rounded, currency: a.currency };
}

/** |actual - expected| <= expected * bps / 10_000, computed exactly in integers. */
export function withinBasisPoints(actual: Money, expected: Money, bps: number): boolean {
  assertSameCurrency(actual, expected);
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError('bps must be a non-negative integer');
  const diff = abs(subtract(actual, expected)).amountMinor;
  const base = expected.amountMinor < 0n ? -expected.amountMinor : expected.amountMinor;
  return diff * 10_000n <= base * BigInt(bps);
}

/** "1234.50 USD", "1200 JPY", "1.500 BHD": the currency's own decimal places. */
export function format(m: Money): string {
  return `${minorToDecimal(m.amountMinor, m.currency)} ${m.currency}`;
}
