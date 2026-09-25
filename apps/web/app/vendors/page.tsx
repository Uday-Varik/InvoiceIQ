import { VendorList } from '../../components/vendors';

export default function VendorsPage() {
  return (
    <section>
      <h1>Vendors</h1>
      <p className="muted">Who can be paid right now. A bank-detail change stops payments until someone else verifies it by callback and the quarantine has run.</p>
      <VendorList />
    </section>
  );
}
