import Link from 'next/link';

export default function LandingPage() {
  return (
    <div className="landing">
      <header className="landing-nav">
        <span className="brand">InvoiceIQ</span>
        <nav>
          <Link href="#features" className="landing-nav-link">Features</Link>
          <Link href="#how-it-works" className="landing-nav-link">How it works</Link>
          <Link href="/login" className="btn btn-small">Sign in</Link>
          <Link href="/login?tab=signup" className="btn btn-primary btn-small">Get started</Link>
        </nav>
      </header>

      <section className="hero" id="main-content">
        <div className="hero-content">
          <span className="hero-badge">AI-powered accounts payable</span>
          <h1 className="hero-title">
            Invoice processing,<br />
            <span className="hero-accent">automated and safe</span>
          </h1>
          <p className="hero-subtitle">
            InvoiceIQ extracts, validates and routes invoices through a payment-safety
            control layer. AI handles the heavy lifting; humans keep the final say.
          </p>
          <div className="hero-actions">
            <Link href="/login?tab=signup" className="btn btn-primary btn-large">
              Start free trial
            </Link>
            <Link href="/login" className="btn btn-large">
              Sign in
            </Link>
          </div>
          <p className="hero-note muted small">No credit card required. Free for up to 50 invoices/month.</p>
        </div>
      </section>

      <section className="features" id="features">
        <h2 className="section-title">Everything you need to manage AP</h2>
        <p className="section-subtitle muted">From upload to payment, InvoiceIQ automates the entire invoice lifecycle.</p>
        <div className="feature-grid">
          <FeatureCard
            icon={<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />}
            iconExtra={<><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></>}
            title="AI extraction"
            description="Upload a PDF or image. The AI reads every field: vendor, amounts, line items, tax, due date, currency."
          />
          <FeatureCard
            icon={<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />}
            title="Payment safety gate"
            description="Every invoice passes through multi-tier validation. AI flags anomalies; it can never approve a payment on its own."
          />
          <FeatureCard
            icon={<><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>}
            title="Multi-tier approvals"
            description="Route invoices based on amount, vendor, or category. Clerks upload, managers approve, controllers pay."
          />
          <FeatureCard
            icon={<><rect x="1" y="4" width="22" height="16" rx="2" ry="2" /><line x1="1" y1="10" x2="23" y2="10" /></>}
            title="Vendor management"
            description="Track vendor spend, payment history, and risk scores. Automatic duplicate detection across your database."
          />
          <FeatureCard
            icon={<><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></>}
            title="Payment runs"
            description="Batch approved invoices into payment runs. Track status from queued through execution to reconciliation."
          />
          <FeatureCard
            icon={<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>}
            title="Tamper-evident audit"
            description="Hash-chained audit log records every action, approval, and correction permanently."
          />
        </div>
      </section>

      <section className="how-it-works" id="how-it-works">
        <h2 className="section-title">How it works</h2>
        <p className="section-subtitle muted">Three steps from invoice to payment.</p>
        <div className="steps">
          <div className="step">
            <div className="step-number">1</div>
            <h3>Upload</h3>
            <p className="muted">Drop a PDF, image, or email attachment. The AI extracts every field in seconds.</p>
          </div>
          <div className="step-arrow" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
            </svg>
          </div>
          <div className="step">
            <div className="step-number">2</div>
            <h3>Review &amp; approve</h3>
            <p className="muted">AI flags anomalies. A human reviews, corrects if needed, and approves or rejects.</p>
          </div>
          <div className="step-arrow" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
            </svg>
          </div>
          <div className="step">
            <div className="step-number">3</div>
            <h3>Pay</h3>
            <p className="muted">Approved invoices are batched into payment runs. Full audit trail, always.</p>
          </div>
        </div>
      </section>

      <section className="cta-section">
        <h2>Ready to automate your AP?</h2>
        <p className="muted">Start processing invoices in minutes. No setup fee, no credit card.</p>
        <div className="hero-actions">
          <Link href="/login?tab=signup" className="btn btn-primary btn-large">
            Get started free
          </Link>
        </div>
      </section>

      <footer className="landing-footer">
        <span className="brand">InvoiceIQ</span>
        <span className="muted small">&copy; 2024 InvoiceIQ. All rights reserved.</span>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon,
  iconExtra,
  title,
  description,
}: {
  icon: React.ReactNode;
  iconExtra?: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="feature-card">
      <div className="feature-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {icon}
          {iconExtra}
        </svg>
      </div>
      <h3>{title}</h3>
      <p className="muted">{description}</p>
    </div>
  );
}
