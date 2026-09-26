'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, createVendor, getVendor, idempotencyKey, listVendors, requestBankChange, setVendorStatus, verifyBankChange, type VendorDetail, type Vendor } from '../lib/api';
import { covers, paymentStatusText, sha256Hex, validateCallbackNote, validateLast4 } from '../lib/controls';
import { personaLabel } from '../lib/personas';
import { useBackend } from './backend';
import { useMe } from './me';

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'The request failed. Try again.');

export function VendorList() {
  const backend = useBackend();
  const me = useMe();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<readonly Vendor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const key = useRef(idempotencyKey());

  const load = useCallback(async (search: string) => {
    try {
      setItems((await listVendors(search)).items);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    if (backend === 'ready') void load('');
  }, [backend, load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createVendor(name.trim(), key.current);
      key.current = idempotencyKey();
      setName('');
      await load(q);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          void load(q);
        }}
      >
        <label>
          Search
          <input type="search" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} placeholder="Vendor name" />
        </label>
        <div className="buttons">
          <button className="btn" type="submit">
            Search
          </button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && <p className="muted">No vendors yet. Invoices register their vendor when they are validated.</p>}
      {items && items.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Status</th>
              <th>Account</th>
              <th>Payments</th>
              <th className="num">Open invoices</th>
            </tr>
          </thead>
          <tbody>
            {items.map((v) => (
              <tr key={v.id}>
                <td>
                  <Link href={`/vendors/${v.id}`}>{v.name}</Link>
                </td>
                <td>{v.status}</td>
                <td>{v.bankAccountLast4 ? `…${v.bankAccountLast4}` : '—'}</td>
                <td>
                  <span className={`pill ${v.payment.blocked ? 'pill-hold' : 'pill-approved'}`}>{paymentStatusText(v)}</span>
                </td>
                <td className="num">{v.openInvoices}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {me && covers(me.roles, 'ap_clerk') && (
        <form className="filters" onSubmit={(e) => void add(e)}>
          <label>
            Register a vendor
            <input value={name} maxLength={256} onChange={(e) => setName(e.target.value)} placeholder="Legal name" />
          </label>
          <div className="buttons">
            <button className="btn" type="submit" disabled={!name.trim()}>
              Register
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function VendorPage({ id }: { id: string }) {
  const backend = useBackend();
  const me = useMe();
  const [vendor, setVendor] = useState<VendorDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setVendor(await getVendor(id));
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    if (backend === 'ready') void load();
  }, [backend, load]);

  if (error && !vendor) return <p className="error">{error}</p>;
  if (!vendor) return <p className="muted">Loading…</p>;
  const latest = vendor.bankChanges[0];

  return (
    <div className="vendor">
      <p>
        <Link href="/vendors">← All vendors</Link>
      </p>
      <h1>{vendor.name}</h1>
      <p>
        <span className={`pill ${vendor.payment.blocked ? 'pill-hold' : 'pill-approved'}`}>{paymentStatusText(vendor)}</span>{' '}
        <span className="muted small">
          {vendor.status} · account {vendor.bankAccountLast4 ? `…${vendor.bankAccountLast4}` : 'not recorded'} · {vendor.openInvoices} open invoice
          {vendor.openInvoices === 1 ? '' : 's'}
        </span>
      </p>
      {error && <p className="error">{error}</p>}

      <h2>Bank details</h2>
      {vendor.bankChanges.length === 0 ? (
        <p className="muted">No bank change recorded. The account lives in the payment system until one is.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Recorded</th>
              <th>Verified by callback</th>
            </tr>
          </thead>
          <tbody>
            {vendor.bankChanges.map((c) => (
              <tr key={c.id}>
                <td>…{c.accountLast4}</td>
                <td>
                  {personaLabel(c.requestedBy)}, {new Date(c.requestedAt).toLocaleString()}
                </td>
                <td>{c.verifiedBy ? `${personaLabel(c.verifiedBy)}: ${c.callbackNote ?? ''}` : c.id === latest?.id ? 'Not yet' : 'Superseded'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {latest && !latest.verifiedBy && me && covers(me.roles, 'ap_manager') && (
        <VerifyForm vendor={vendor} changeId={latest.id} requestedBy={latest.requestedBy} meId={me.userId} onDone={load} onError={setError} />
      )}
      {me && covers(me.roles, 'ap_clerk') && <BankChangeForm vendorId={vendor.id} onDone={load} onError={setError} />}
      {me && covers(me.roles, 'ap_manager') && <StatusToggle vendor={vendor} onDone={load} onError={setError} />}
    </div>
  );
}

function BankChangeForm({ vendorId, onDone, onError }: { vendorId: string; onDone: () => Promise<void>; onError: (e: string) => void }) {
  const [last4, setLast4] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(idempotencyKey());
  const parsed = validateLast4(last4);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!parsed.ok || !file) return;
    setBusy(true);
    try {
      await requestBankChange(vendorId, parsed.value, await sha256Hex(await file.arrayBuffer()), key.current);
      key.current = idempotencyKey();
      setLast4('');
      setFile(null);
      await onDone();
    } catch (err) {
      onError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="correction" onSubmit={(e) => void submit(e)} aria-label="Record a bank change">
      <h3>Record a bank change</h3>
      <p className="muted small">Payments to this vendor stop at once, until someone else verifies the change by calling the vendor and the quarantine has run.</p>
      <div className="grid-2">
        <label>
          New account, last 4
          <input value={last4} maxLength={4} onChange={(e) => setLast4(e.target.value)} placeholder="1234" />
          {last4 && !parsed.ok && <span className="error small">{parsed.error}</span>}
        </label>
        <label>
          Evidence (the vendor&apos;s letter; only its SHA-256 is sent)
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      <div className="buttons">
        <button className="btn btn-danger" type="submit" disabled={busy || !parsed.ok || !file}>
          Record change and stop payments
        </button>
      </div>
    </form>
  );
}

function VerifyForm(props: { vendor: VendorDetail; changeId: string; requestedBy: string; meId: string; onDone: () => Promise<void>; onError: (e: string) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(idempotencyKey());
  const noteError = validateCallbackNote(note);
  if (props.requestedBy === props.meId) {
    return <p className="warn small">You recorded the latest bank change, so someone else must verify it.</p>;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (noteError) return;
    setBusy(true);
    try {
      await verifyBankChange(props.vendor.id, props.changeId, note.trim(), key.current);
      key.current = idempotencyKey();
      setNote('');
      await props.onDone();
    } catch (err) {
      props.onError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="correction" onSubmit={(e) => void submit(e)} aria-label="Verify the bank change">
      <h3>Verify the latest change by callback</h3>
      <textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="Called Jane Doe on +1 555 0100 (number from the vendor file, not the letter); she confirmed the new account ending …" />
      <div className="buttons">
        <button className="btn btn-primary" type="submit" disabled={busy || noteError !== undefined}>
          Record verification
        </button>
      </div>
    </form>
  );
}

function StatusToggle({ vendor, onDone, onError }: { vendor: VendorDetail; onDone: () => Promise<void>; onError: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  const next = vendor.status === 'active' ? 'inactive' : 'active';
  return (
    <div className="buttons">
      <button
        className={`btn${next === 'inactive' ? ' btn-danger' : ''}`}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setVendorStatus(vendor.id, vendor.version, next)
            .then(onDone)
            .catch((err: unknown) => onError(errorText(err)))
            .finally(() => setBusy(false));
        }}
      >
        {next === 'inactive' ? 'Deactivate vendor' : 'Reactivate vendor'}
      </button>
    </div>
  );
}
