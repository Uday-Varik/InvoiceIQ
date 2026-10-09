import Link from 'next/link';
import { InvoiceList } from '../../../components/invoice-list';
import { PageHeader } from '../../../components/page-header';
import { UploadDropzone } from '../../../components/upload';
import { Card } from '../../../components/ui/card';

export default function Home() {
  return (
    <>
      <PageHeader
        title="Upload an invoice"
        description="It is extracted, validated and routed through the payment-safety gate. AI can only ever put an invoice on hold; approval is always a human decision."
      />
      <UploadDropzone />
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Recent invoices</h2>
          <Link href="/invoices" className="text-sm font-medium text-primary hover:underline">
            All invoices, filters and export
          </Link>
        </div>
        <InvoiceList />
      </Card>
    </>
  );
}
