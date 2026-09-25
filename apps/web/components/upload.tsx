'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type DragEvent } from 'react';
import { ApiError, uploadInvoice } from '../lib/api';
import { useBackend } from './backend';

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
    <div>
      <div
        className={`dropzone${dragging ? ' dropzone-active' : ''}${disabled ? ' dropzone-disabled' : ''}`}
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
      >
        <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => void send(e.target.files?.[0])} />
        <p className="dropzone-title">{busy ? 'Uploading…' : backend === 'ready' ? 'Drop an invoice here, or click to choose' : 'Waiting for the API…'}</p>
        <p className="muted">PDF, PNG or JPEG, up to 10 MB. PDFs with a text layer extract best.</p>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="muted small">
        No invoice handy? <a href="/sample-invoice.pdf" download>Download a sample PDF</a> and drop it back in.
      </p>
    </div>
  );
}
