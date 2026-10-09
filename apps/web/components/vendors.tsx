'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent, type FormHTMLAttributes, type ReactNode } from 'react';
import { ApiError, createVendor, getVendor, idempotencyKey, listVendors, requestBankChange, setVendorStatus, verifyBankChange, type VendorDetail, type Vendor } from '../lib/api';
import { covers, paymentStatusText, sha256Hex, validateCallbackNote, validateLast4 } from '../lib/controls';
import { personaLabel } from '../lib/personas';
import { useBackend } from './backend';
import { useMe } from './me';
import { inputClass, textareaClass } from './ui/field';
import { cn } from '../lib/utils';
import { PageHeader } from './page-header';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Table, TableCell, TableHead, TableRow } from './ui/table';

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'The request failed. Try again.');

function PaymentBadge({ vendor }: { vendor: Vendor | VendorDetail }) {
  return <Badge tone={vendor.payment.blocked ? 'hold' : 'success'}>{paymentStatusText(vendor)}</Badge>;
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">
      {message}
    </p>
  );
}

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
    <div className="space-y-6">
      <PageHeader
        title="Vendors"
        description="Who can be paid now. A bank detail change stops payments until someone else verifies it by callback."
      />
      <Card className="p-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void load(q);
          }}
        >
          <label className="grid min-w-56 flex-1 gap-1 text-sm">
            <span className="text-muted-foreground">Search</span>
            <input className={inputClass} type="search" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} placeholder="Vendor name" />
          </label>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
      </Card>
      {error && <ErrorLine message={error} />}
      {items && items.length === 0 && (
        <Card className="p-6 text-sm text-muted-foreground">No vendors yet. Invoices register their vendor when they are validated.</Card>
      )}
      {items && items.length > 0 && (
        <Card className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <TableHead>Vendor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Payments</TableHead>
                <TableHead className="text-right">Open invoices</TableHead>
              </tr>
            </thead>
            <tbody>
              {items.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>
                    <Link href={`/vendors/${v.id}`} className="font-medium text-primary hover:underline">
                      {v.name}
                    </Link>
                  </TableCell>
                  <TableCell className="capitalize">{v.status}</TableCell>
                  <TableCell className="tabular-nums">{v.bankAccountLast4 ? `…${v.bankAccountLast4}` : '—'}</TableCell>
                  <TableCell>
                    <PaymentBadge vendor={v} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{v.openInvoices}</TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {me && covers(me.roles, 'ap_clerk') && (
        <Card className="p-4">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => void add(e)}>
            <label className="grid min-w-56 flex-1 gap-1 text-sm">
              <span className="text-muted-foreground">Register a vendor</span>
              <input className={inputClass} value={name} maxLength={256} onChange={(e) => setName(e.target.value)} placeholder="Legal name" />
            </label>
            <Button type="submit" disabled={!name.trim()}>
              Register
            </Button>
          </form>
        </Card>
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

  if (error && !vendor) return <ErrorLine message={error} />;
  if (!vendor) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const latest = vendor.bankChanges[0];

  return (
    <div className="space-y-6">
      <Link href="/vendors" className="text-sm text-primary hover:underline">
        ← All vendors
      </Link>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{vendor.name}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <PaymentBadge vendor={vendor} />
          <span>
            {vendor.status} · account {vendor.bankAccountLast4 ? `…${vendor.bankAccountLast4}` : 'not recorded'} · {vendor.openInvoices} open invoice
            {vendor.openInvoices === 1 ? '' : 's'}
          </span>
        </div>
      </header>
      {error && <ErrorLine message={error} />}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Bank details</h2>
        {vendor.bankChanges.length === 0 ? (
          <Card className="p-4 text-sm text-muted-foreground">No bank change recorded. The account lives in the payment system until one is.</Card>
        ) : (
          <Card className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <TableHead>Account</TableHead>
                  <TableHead>Recorded</TableHead>
                  <TableHead>Verified by callback</TableHead>
                </tr>
              </thead>
              <tbody>
                {vendor.bankChanges.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="tabular-nums">…{c.accountLast4}</TableCell>
                    <TableCell>
                      {personaLabel(c.requestedBy)}, {new Date(c.requestedAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      {c.verifiedBy ? `${personaLabel(c.verifiedBy)}: ${c.callbackNote ?? ''}` : c.id === latest?.id ? 'Not yet' : 'Superseded'}
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
      </section>

      {latest && !latest.verifiedBy && me && covers(me.roles, 'ap_manager') && (
        <VerifyForm vendor={vendor} changeId={latest.id} requestedBy={latest.requestedBy} meId={me.userId} onDone={load} onError={setError} />
      )}
      {me && covers(me.roles, 'ap_clerk') && <BankChangeForm vendorId={vendor.id} onDone={load} onError={setError} />}
      {me && covers(me.roles, 'ap_manager') && <StatusToggle vendor={vendor} onDone={load} onError={setError} />}
    </div>
  );
}

function FormCard({ title, children, ...props }: { title: string; children: ReactNode } & FormHTMLAttributes<HTMLFormElement>) {
  return (
    <Card className="p-5">
      <form className="space-y-4" {...props}>
        <h3 className="font-semibold">{title}</h3>
        {children}
      </form>
    </Card>
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
    <FormCard title="Record a bank change" aria-label="Record a bank change" onSubmit={(e) => void submit(e)}>
      <p className="text-sm text-muted-foreground">
        Payments to this vendor stop at once, until someone else verifies the change by calling the vendor and the quarantine has run.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">New account, last 4</span>
          <input className={inputClass} value={last4} maxLength={4} onChange={(e) => setLast4(e.target.value)} placeholder="1234" />
          {last4 && !parsed.ok && <span className="text-xs text-rose-700 dark:text-rose-300">{parsed.error}</span>}
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Evidence (the vendor&apos;s letter; only its SHA-256 is sent)</span>
          <input type="file" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      <div>
        <Button type="submit" variant="outline" className="border-rose-300 text-rose-700 hover:bg-rose-50 dark:text-rose-300" disabled={busy || !parsed.ok || !file}>
          Record change and stop payments
        </Button>
      </div>
    </FormCard>
  );
}

function VerifyForm(props: { vendor: VendorDetail; changeId: string; requestedBy: string; meId: string; onDone: () => Promise<void>; onError: (e: string) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(idempotencyKey());
  const noteError = validateCallbackNote(note);
  if (props.requestedBy === props.meId) {
    return (
      <Card className="border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200">
        You recorded the latest bank change, so someone else must verify it.
      </Card>
    );
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
    <FormCard title="Verify the latest change by callback" aria-label="Verify the bank change" onSubmit={(e) => void submit(e)}>
      <textarea
        value={note}
        maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Called Jane Doe on +1 555 0100 (number from the vendor file, not the letter); she confirmed the new account ending …"
        className={cn(textareaClass, 'min-h-20')}
      />
      <div>
        <Button type="submit" disabled={busy || noteError !== undefined}>
          Record verification
        </Button>
      </div>
    </FormCard>
  );
}

function StatusToggle({ vendor, onDone, onError }: { vendor: VendorDetail; onDone: () => Promise<void>; onError: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  const next = vendor.status === 'active' ? 'inactive' : 'active';
  return (
    <div>
      <Button
        variant="outline"
        className={next === 'inactive' ? 'border-rose-300 text-rose-700 hover:bg-rose-50 dark:text-rose-300' : undefined}
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
      </Button>
    </div>
  );
}
