import { PaymentRuns } from '../../components/payments';

export default function PaymentsPage() {
  return (
    <section>
      <h1>Payment runs</h1>
      <p className="muted">
        A manager assembles approved invoices into a run; a controller who did not assemble it confirms it was paid. Vendors that cannot be
        paid are held, never queued.
      </p>
      <PaymentRuns />
    </section>
  );
}
