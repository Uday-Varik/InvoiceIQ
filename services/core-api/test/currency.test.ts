import { describe, expect, it } from 'vitest';
import { CURRENCY_EXPONENTS, DEFAULT_EXPONENT, currencyExponent, format, minorToDecimal, money } from '../src/domain/index.js';
import { formatMinor } from '../src/invoices/export.js';

describe('currency exponents', () => {
  it.each([
    ['USD', 2],
    ['EUR', 2],
    ['INR', 2],
    ['JPY', 0],
    ['KRW', 0],
    ['VND', 0],
    ['BHD', 3],
    ['KWD', 3],
    ['CLF', 4],
  ])('%s has %i decimals', (code, e) => expect(currencyExponent(code)).toBe(e));

  it('an unknown or missing currency falls back to 2', () => {
    expect(currencyExponent('XYZ')).toBe(DEFAULT_EXPONENT);
    expect(currencyExponent(null)).toBe(2);
    expect(currencyExponent(undefined)).toBe(2);
  });

  it('lists only exponents other than the default, with valid codes', () => {
    for (const [code, e] of Object.entries(CURRENCY_EXPONENTS)) {
      expect(code).toMatch(/^[A-Z]{3}$/);
      expect([0, 3, 4]).toContain(e);
    }
  });

  it('cannot be changed at runtime', () => {
    expect(Object.isFrozen(CURRENCY_EXPONENTS)).toBe(true);
  });
});

describe('minorToDecimal', () => {
  it.each([
    ['123450', 'USD', '1234.50'],
    ['5', 'USD', '0.05'],
    ['-5', 'EUR', '-0.05'],
    ['0', 'USD', '0.00'],
    ['1200', 'JPY', '1200'],
    ['-1200', 'JPY', '-1200'],
    ['0', 'JPY', '0'],
    ['1500', 'BHD', '1.500'],
    ['7', 'KWD', '0.007'],
    ['-7', 'KWD', '-0.007'],
    ['12345', 'CLF', '1.2345'],
    ['007', 'USD', '0.07'],
    ['-0', 'USD', '0.00'],
    ['922337203685477580', 'JPY', '922337203685477580'],
  ])('%s %s -> %s', (minor, code, expected) => expect(minorToDecimal(minor, code)).toBe(expected));

  it('takes bigints', () => expect(minorToDecimal(123456n, 'BHD')).toBe('123.456'));

  it('refuses anything but an integer', () => {
    for (const bad of ['1.5', '', '1e3', ' 1', 'abc']) expect(() => minorToDecimal(bad, 'USD'), bad).toThrow(RangeError);
  });
});

describe('money formatting uses the currency exponent', () => {
  it('formats yen without decimals and dinars with three', () => {
    expect(format(money(12000, 'JPY'))).toBe('12000 JPY');
    expect(format(money(1500, 'BHD'))).toBe('1.500 BHD');
    expect(format(money(123456, 'USD'))).toBe('1234.56 USD');
  });

  it('exports each amount in its own currency', () => {
    expect(formatMinor('12000', 'JPY')).toBe('12000');
    expect(formatMinor('12000', 'KWD')).toBe('12.000');
    expect(formatMinor('12000', null)).toBe('120.00');
  });
});
