import { VendorPage } from '../../../components/vendors';

export default async function Vendor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VendorPage id={id} />;
}
