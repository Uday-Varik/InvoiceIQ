'use client';

import { useRef, useState, type FormEvent } from 'react';
import { ApiError, correctInvoice, idempotencyKey, type Invoice } from '../lib/api';
import { minorToInput } from '../lib/money';
import { arithmeticHint, buildCorrection, EMPTY_LINE, formFromInvoice, type CorrectionForm, type FormErrors, type LineForm } from '../lib/corrections';

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
    <label className={errors[k] ? 'invalid' : undefined}>
      {label}
      <input value={form[k]} onChange={(e) => set(k, e.target.value)} aria-invalid={errors[k] ? true : undefined} {...props} />
      {errors[k] && <span className="error small">{errors[k]}</span>}
    </label>
  );

  return (
    <form className="correction" onSubmit={(e) => void onSubmit(e)} aria-label="Correct extracted fields">
      <h2>Correct the extracted fields</h2>
      <div className="grid-2">
        {input('vendorName', 'Vendor', { maxLength: 256 })}
        {input('invoiceNumber', 'Invoice number', { maxLength: 64 })}
        {input('invoiceDate', 'Invoice date', { type: 'date' })}
        {input('dueDate', 'Due date', { type: 'date' })}
        {input('currency', 'Currency', { maxLength: 3, placeholder: 'USD' })}
        {input('total', 'Total', { inputMode: 'decimal', placeholder: zero })}
        {input('subtotal', 'Subtotal (optional)', { inputMode: 'decimal', placeholder: zero })}
        {input('tax', 'Tax (optional)', { inputMode: 'decimal', placeholder: zero })}
      </div>

      <h3>Line items</h3>
      <table className="table lines-edit">
        <thead>
          <tr>
            <th>Description</th>
            <th className="num">Qty</th>
            <th className="num">Unit price</th>
            <th className="num">Amount</th>
            <th aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {form.lines.map((l, i) => (
            <tr key={i} className={errors.lines?.[i] ? 'invalid' : undefined}>
              <td>
                <input aria-label={`Line ${i + 1} description`} value={l.description} maxLength={500} onChange={(e) => setLine(i, { description: e.target.value })} />
                {errors.lines?.[i] && <span className="error small">{errors.lines[i]}</span>}
              </td>
              <td className="num">
                <input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" size={6} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
              </td>
              <td className="num">
                <input aria-label={`Line ${i + 1} unit price`} inputMode="decimal" size={9} value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
              </td>
              <td className="num">
                <input aria-label={`Line ${i + 1} amount`} inputMode="decimal" size={9} value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} />
              </td>
              <td>
                <button type="button" className="btn btn-small" aria-label={`Remove line ${i + 1}`} onClick={() => set('lines', form.lines.filter((_, j) => j !== i))}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn btn-small" disabled={form.lines.length >= 200} onClick={() => set('lines', [...form.lines, { ...EMPTY_LINE }])}>
        Add line
      </button>

      {hint && (
        <p className="warn small" role="status">
          {hint}. Saving will put the invoice in EXCEPTION until the numbers agree.
        </p>
      )}
      <textarea placeholder="Why you corrected it (optional, kept in the audit log)" value={form.comment} maxLength={2000} onChange={(e) => set('comment', e.target.value)} />
      <div className="buttons">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save and re-validate'}
        </button>
        <button className="btn" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {serverError && (
        <p className="error" role="alert">
          {serverError}
        </p>
      )}
    </form>
  );
}
