import Link from 'next/link';
import { InvoiceList } from '../components/invoice-list';
import { UploadDropzone } from '../components/upload';

export default function Home() {
  return (
    <>
      <section>
        <h1>Upload an invoice</h1>
        <p className="muted">
          It is extracted, validated and routed through the payment-safety gate. AI can only ever put an invoice on hold;
          approval is always a human decision.
        </p>
        <UploadDropzone />
      </section>
      <section>
        <h2>Recent invoices</h2>
        <InvoiceList />
        <p>
          <Link href="/invoices">All invoices, filters and export →</Link>
        </p>
      </section>
    </>
  );
}
