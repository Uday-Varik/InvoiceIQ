import { InvoiceReview } from '../../../components/review';

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoiceReview id={id} />;
}
