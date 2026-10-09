'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type DragEvent } from 'react';
import { ApiError, uploadInvoice } from '../lib/api';
import { cn } from '../lib/utils';
import { useBackend } from './backend';
import { Card } from './ui/card';

const ACCEPT = 'application/pdf,image/png,image/jpeg';
const MAX_BYTES = 10 * 1024 * 1024;

export function UploadDropzone() {
  const router = useRouter();
  const backend = useBackend();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || backend !== 'ready';

  async function send(file: File | undefined) {
    if (!file || disabled) return;
    setError(null);
    if (file.size > MAX_BYTES) {
      setError('That file is over the 10 MB limit.');
      return;
    }
    setBusy(true);
    try {
      const invoice = await uploadInvoice(file);
      router.push(`/invoices/${invoice.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed. Check your connection and try again.');
      setBusy(false);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    void send(e.dataTransfer.files[0]);
  }

  return (
    <div className="space-y-2">
      <Card
        role="button"
        tabIndex={0}
        aria-disabled={disabled}
        onClick={() => !disabled && input.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !disabled && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'grid cursor-pointer place-items-center gap-1 border-2 border-dashed p-8 text-center shadow-none transition-colors',
          dragging ? 'border-primary bg-muted' : 'border-border hover:bg-muted/50',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => void send(e.target.files?.[0])} />
        <p className="font-medium">
          {busy ? (
            <span className="inline-flex items-center gap-2" role="status">
              <span className="spinner" aria-hidden="true" />
              Uploading…
            </span>
          ) : backend === 'ready' ? (
            'Drop an invoice here, or click to choose'
          ) : (
            'Waiting for the API…'
          )}
        </p>
        <p className="text-sm text-muted-foreground">PDF, PNG or JPEG, up to 10 MB. PDFs with a text layer extract best.</p>
      </Card>
      {error && (
        <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">
          {error}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        No invoice handy? <a href="/sample-invoice.pdf" download>Download a sample PDF</a> and drop it back in.
      </p>
    </div>
  );
}
