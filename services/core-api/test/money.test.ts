import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  abs,
  add,
  equals,
  format,
  money,
  multiplyByMilli,
  subtract,
  sum,
  withinBasisPoints,
} from '../src/domain/index.js';

describe('money', () => {
  it('stores amounts as bigint minor units', () => {
    expect(money(1999, 'USD')).toEqual({ amountMinor: 1999n, currency: 'USD' });
  });

  it.each(['usd', 'US', 'USDT', ''])('rejects invalid currency %j', (c) => {
    expect(() => money(1, c)).toThrow(RangeError);
  });

  it('rejects fractional or unsafe numbers', () => {
    expect(() => money(1.5, 'USD')).toThrow(RangeError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, 'USD')).toThrow(RangeError);
  });

  it('adds and subtracts in the same currency', () => {
    expect(add(money(100, 'EUR'), money(250, 'EUR')).amountMinor).toBe(350n);
    expect(subtract(money(100, 'EUR'), money(250, 'EUR')).amountMinor).toBe(-150n);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(1, 'USD'), money(1, 'EUR'))).toThrow(CurrencyMismatchError);
  });

  it('sums an empty list to zero', () => {
    expect(sum([], 'GBP')).toEqual(money(0, 'GBP'));
  });

  it('sums many values exactly (no float drift)', () => {
    const items = Array.from({ length: 1000 }, () => money(10, 'USD'));
    expect(sum(items, 'USD').amountMinor).toBe(10_000n);
  });

  it('compares by value and currency', () => {
    expect(equals(money(5, 'USD'), money(5, 'USD'))).toBe(true);
    expect(equals(money(5, 'USD'), money(5, 'CAD'))).toBe(false);
    expect(abs(money(-5, 'USD')).amountMinor).toBe(5n);
  });

  it.each([
    [1000n, 1500n, 1500n],
    [333n, 1500n, 500n], // 499.5 -> 500
    [1n, 500n, 1n], // 0.5 -> 1
    [1n, 499n, 0n],
    [-333n, 1500n, -500n],
  ])('multiplyByMilli(%s, %s) = %s', (amt, qty, expected) => {
    expect(multiplyByMilli(money(amt, 'USD'), qty).amountMinor).toBe(expected);
  });

  it.each([
    [10_050, 10_000, 50, true],
    [10_051, 10_000, 50, false],
    [9_950, 10_000, 50, true],
    [9_949, 10_000, 50, false],
    [10_000, 10_000, 0, true],
  ])('withinBasisPoints(%s, %s, %s bps) = %s', (a, e, bps, expected) => {
    expect(withinBasisPoints(money(a, 'USD'), money(e, 'USD'), bps)).toBe(expected);
  });

  it('rejects negative or fractional bps', () => {
    expect(() => withinBasisPoints(money(1, 'USD'), money(1, 'USD'), -1)).toThrow(RangeError);
    expect(() => withinBasisPoints(money(1, 'USD'), money(1, 'USD'), 1.5)).toThrow(RangeError);
  });

  it('formats for humans', () => {
    expect(format(money(123456, 'USD'))).toBe('1234.56 USD');
    expect(format(money(-5, 'EUR'))).toBe('-0.05 EUR');
  });
});
