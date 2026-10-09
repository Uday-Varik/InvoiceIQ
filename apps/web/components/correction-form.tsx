'use client';

import { useRef, useState, type FormEvent } from 'react';
import { ApiError, correctInvoice, idempotencyKey, type Invoice } from '../lib/api';
import { minorToInput } from '../lib/money';
import { arithmeticHint, buildCorrection, EMPTY_LINE, formFromInvoice, type CorrectionForm, type FormErrors, type LineForm } from '../lib/corrections';
import { cn } from '../lib/utils';
import { inputClass, textareaClass } from './ui/field';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Notice } from './ui/notice';

/**
 * Edit-before-approve. Saving sends only the changed fields with the version
 * the reviewer saw; the server records the before/after in the audit log and
 * re-validates, so the invoice may come back in a different state (for
 * example EXCEPTION when the corrected numbers do not add up).
 */
export function CorrectionFormPanel({ invoice, onSaved, onCancel }: { invoice: Invoice; onSaved: (inv: Invoice) => void; onCancel: () => void }) {
  const [form, setForm] = useState<CorrectionForm>(() => formFromInvoice(invoice));
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // One key per intended save, reused on retry so a double submit cannot apply twice.
  const key = useRef(idempotencyKey());

  const hint = arithmeticHint(form);
  const zero = minorToInput('0', form.currency);
  const set = <K extends keyof CorrectionForm>(k: K, v: CorrectionForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setLine = (i: number, patch: Partial<LineForm>) => set('lines', form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setServerError(null);
    const built = buildCorrection(invoice, form);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    if (built.changed.length === 0) {
      setServerError('Nothing changed.');
      return;
    }
    setBusy(true);
    try {
      onSaved(await correctInvoice(invoice.id, built.body, key.current));
      key.current = idempotencyKey();
    } catch (err) {
      setServerError(
        err instanceof ApiError && err.problem.code === 'VERSION_CONFLICT'
          ? 'Someone else changed this invoice. Reload the page to see their change, then correct again.'
          : err instanceof ApiError
            ? err.message
            : 'The request failed. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  const input = (k: Exclude<keyof CorrectionForm, 'lines'>, label: string, props: Record<string, unknown> = {}) => (
    <label className="grid gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input className={inputClass} value={form[k]} onChange={(e) => set(k, e.target.value)} aria-invalid={errors[k] ? true : undefined} {...props} />
      {errors[k] && <span className="text-xs text-rose-700 dark:text-rose-300">{errors[k]}</span>}
    </label>
  );

  return (
    <Card className="p-5">
      <form className="space-y-5" onSubmit={(e) => void onSubmit(e)} aria-label="Correct extracted fields">
        <h2 className="font-semibold">Correct the extracted fields</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {input('vendorName', 'Vendor', { maxLength: 256 })}
          {input('invoiceNumber', 'Invoice number', { maxLength: 64 })}
          {input('invoiceDate', 'Invoice date', { type: 'date' })}
          {input('dueDate', 'Due date', { type: 'date' })}
          {input('currency', 'Currency', { maxLength: 3, placeholder: 'USD' })}
          {input('total', 'Total', { inputMode: 'decimal', placeholder: zero })}
          {input('subtotal', 'Subtotal (optional)', { inputMode: 'decimal', placeholder: zero })}
          {input('tax', 'Tax (optional)', { inputMode: 'decimal', placeholder: zero })}
          {input('paymentTerms', 'Payment terms (optional)', { maxLength: 100 })}
          {input('poNumber', 'PO number (optional)', { maxLength: 64 })}
          {input('vendorAddress', 'Vendor address (optional)', { maxLength: 500 })}
          {input('vendorTaxId', 'Tax ID (optional)', { maxLength: 64 })}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Line items</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Unit price</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2" aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {form.lines.map((l, i) => (
                  <tr key={i} className={cn('border-b border-border last:border-0', errors.lines?.[i] && 'bg-rose-50 dark:bg-rose-400/10')}>
                    <td className="px-3 py-2">
                      <input
                        className={inputClass}
                        aria-label={`Line ${i + 1} description`}
                        value={l.description}
                        maxLength={500}
                        onChange={(e) => setLine(i, { description: e.target.value })}
                      />
                      {errors.lines?.[i] && <span className="text-xs text-rose-700 dark:text-rose-300">{errors.lines[i]}</span>}
                    </td>
                    <td className="px-3 py-2">
                      <input
                        className={cn(inputClass, 'w-20 text-right tabular-nums')}
                        aria-label={`Line ${i + 1} quantity`}
                        inputMode="decimal"
                        value={l.quantity}
                        onChange={(e) => setLine(i, { quantity: e.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        className={cn(inputClass, 'w-28 text-right tabular-nums')}
                        aria-label={`Line ${i + 1} unit price`}
                        inputMode="decimal"
                        value={l.unitPrice}
                        onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        className={cn(inputClass, 'w-28 text-right tabular-nums')}
                        aria-label={`Line ${i + 1} amount`}
                        inputMode="decimal"
                        value={l.amount}
                        onChange={(e) => setLine(i, { amount: e.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove line ${i + 1}`}
                        onClick={() => set('lines', form.lines.filter((_, j) => j !== i))}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={form.lines.length >= 200} onClick={() => set('lines', [...form.lines, { ...EMPTY_LINE }])}>
            Add line
          </Button>
        </div>

        {hint && (
          <Notice role="status">
            {hint}. Saving will put the invoice in EXCEPTION until the numbers agree.
          </Notice>
        )}
        <textarea
          placeholder="Why you corrected it (optional, kept in the audit log)"
          value={form.comment}
          maxLength={2000}
          onChange={(e) => set('comment', e.target.value)}
          className={cn(textareaClass, 'min-h-20')}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save and re-validate'}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {serverError && (
          <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">
            {serverError}
          </p>
        )}
      </form>
    </Card>
  );
}
