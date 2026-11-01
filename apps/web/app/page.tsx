import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  ArrowUp,
  Building2,
  Check,
  Copy,
  FileSearch,
  Landmark,
  Lock,
  ScrollText,
  ShieldAlert,
  Wallet,
  Workflow,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { Reveal } from '../components/landing-motion';

const STATS = [
  { value: '12', label: 'invoice fields extracted by AI, including PO number, payment terms and tax ID' },
  { value: '14', label: 'lifecycle states, so every invoice has one honest status' },
  { value: '18', label: 'reason codes that explain every hold, match failure and exception' },
  { value: '0', label: 'paths for the AI to approve or release a payment on its own' },
];

const STEPS = [
  {
    icon: FileSearch,
    title: 'Capture',
    body: 'Drop in PDFs, photos or scans. OCR reads paper invoices the same way it reads digital ones.',
  },
  {
    icon: Workflow,
    title: 'Extract and match',
    body: 'AI pulls every field and matches the invoice against its purchase order and the goods received.',
  },
  {
    icon: ShieldAlert,
    title: 'Check and hold',
    body: 'Duplicates, changed bank details and out-of-policy amounts are held for a person to look at.',
  },
  {
    icon: Wallet,
    title: 'Approve and pay',
    body: 'Approvals follow your tiers. Approved invoices move into payment runs, and every step is logged.',
  },
];

const FEATURES: { icon: LucideIcon; title: string; body: string; span: boolean }[] = [
  {
    icon: FileSearch,
    title: 'AI extraction that shows its work',
    body: 'Every extracted field carries a confidence score. Anything uncertain goes to a reviewer, with the source text beside it.',
    span: true,
  },
  {
    icon: Copy,
    title: 'Duplicate detection',
    body: 'Invoices that match an earlier one are flagged before they can reach a payment run.',
    span: false,
  },
  {
    icon: Landmark,
    title: 'Bank-change quarantine',
    body: 'When a vendor’s bank details change, payments to that vendor are held until someone verifies the change.',
    span: false,
  },
  {
    icon: Building2,
    title: 'Multi-tier approvals',
    body: 'Route by amount, vendor or category. Clerks capture, managers approve, controllers release payment runs.',
    span: false,
  },
  {
    icon: Wallet,
    title: 'Payment runs',
    body: 'Batch approved invoices into a run and follow it from queued through execution to reconciliation.',
    span: false,
  },
  {
    icon: ScrollText,
    title: 'Tamper-evident audit log',
    body: 'Every action is hash-chained to the one before it. Editing history breaks the chain, so auditors can verify it.',
    span: true,
  },
];

const ROLES = [
  { role: 'AP clerk', body: 'Uploads invoices, corrects extracted fields and clears the simple cases.' },
  { role: 'AP manager', body: 'Reviews held invoices and approves within their tier, with the reason on screen.' },
  { role: 'Controller', body: 'Releases payment runs and resolves bank-change and duplicate holds.' },
  { role: 'CFO', body: 'Sees spend, approval turnaround and audit status without digging through inboxes.' },
];

const SAFETY = [
  ['Type system', 'AI reason codes accept exactly one outcome: HOLD. Any other outcome fails to compile.'],
  ['Lifecycle gate', 'The state machine refuses any AI-driven transition except into HOLD. Tests replay 200 AI-driven invoices and none reach payment.'],
  ['API contract', 'The signal schema allows only HOLD in OpenAPI, Zod and Pydantic, so the contract cannot drift.'],
  ['Import rules', 'The AI service has no database credentials and cannot load database drivers. CI enforces that boundary.'],
];

const MARQUEE = [
  'Three-way match',
  'Duplicate detection',
  'Bank-change quarantine',
  'Hash-chained audit',
  'AI can only hold',
  'Multi-tier approvals',
];

export default function LandingPage() {
  return (
    <div className="mx-landing">
      <header className="mx-header">
        <div className="mx-wrap mx-header-inner">
          <Link href="/" aria-label="InvoiceIQ home" className="mx-brand">
            <Image src="/brand/logo-light.png" alt="InvoiceIQ" width={800} height={267} className="mx-logo" priority />
          </Link>
          <nav aria-label="Primary" className="mx-nav">
            <a href="#product"><span className="mx-nav-num">01</span>Product</a>
            <a href="#how-it-works"><span className="mx-nav-num">02</span>How it works</a>
            <a href="#safety"><span className="mx-nav-num">03</span>Safety</a>
          </nav>
          <div className="mx-header-actions">
            <Link href="/login" className="mx-signin">
              Sign in
            </Link>
            <Link href="/login?tab=signup" className="mx-cta-pill">
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main id="main-content">
        <section className="mx-hero">
          <div aria-hidden="true" className="mx-hero-glow" />
          <div aria-hidden="true" className="mx-hero-grid" />
          <p aria-hidden="true" className="mx-outline-word">HOLD</p>
          <div className="mx-wrap mx-hero-inner">
            <div className="mx-hero-copy">
              <p className="mx-meta-row">
                <span>Accounts payable</span>
                <span className="mx-meta-dot" aria-hidden="true" />
                <span>AI can only hold</span>
              </p>
              <p className="mx-eyebrow">
                <span className="mx-eyebrow-dot" aria-hidden="true" />
                AI reads. Controls decide. People approve.
              </p>
              <h1 className="mx-display">
                Pay every invoice{' '}
                <span className="mx-display-accent">right the first time.</span>
              </h1>
              <p className="mx-lede">
                InvoiceIQ extracts every field from your invoices, matches them to purchase orders and holds anything
                suspicious before money moves. Our AI can slow a payment down. It cannot speed one up.
              </p>
              <div className="mx-hero-actions">
                <Link href="/login?tab=signup" className="mx-btn-primary">
                  Create your account
                  <ArrowRight className="mx-btn-icon" aria-hidden="true" />
                </Link>
                <a href="#how-it-works" className="mx-btn-ghost">
                  See how it works
                </a>
              </div>
              <p className="mx-checks">
                {['Duplicate detection', 'Bank-change quarantine', 'Hash-chained audit log'].map((item) => (
                  <span key={item} className="mx-check">
                    <Check className="mx-check-icon" aria-hidden="true" />
                    {item}
                  </span>
                ))}
              </p>
            </div>

            <HeroPanel />
          </div>
          <p aria-hidden="true" className="mx-scroll-cue">
            <span>Scroll</span>
            <span className="mx-scroll-line" />
          </p>
        </section>

        <div className="mx-marquee" aria-hidden="true">
          <div className="mx-marquee-track">
            {[0, 1].map((copy) => (
              <span key={copy} className="mx-marquee-copy">
                {MARQUEE.map((item) => (
                  <span key={item} className="mx-marquee-item">
                    {item}
                    <span className="mx-marquee-diamond">◆</span>
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>

        <section aria-label="Key numbers" className="mx-section mx-stats">
          <div className="mx-wrap">
            <dl className="mx-stats-grid">
              {STATS.map((stat) => (
                <Reveal key={stat.value} className="mx-stat">
                  <dd className="mx-stat-value">{stat.value}</dd>
                  <dt className="mx-stat-label">{stat.label}</dt>
                </Reveal>
              ))}
            </dl>
          </div>
        </section>

        <section id="how-it-works" className="mx-section">
          <div className="mx-wrap">
            <Reveal focus>
              <p className="mx-section-eyebrow">02 — How it works</p>
              <h2 className="mx-title">From a stack of PDFs to a payment run in four steps</h2>
              <p className="mx-section-body">
                Each step has a clear owner and a visible result. Nothing skips a step, and nothing is hidden from the
                audit log.
              </p>
            </Reveal>
            <ol className="mx-steps">
              {STEPS.map((step, index) => (
                <Reveal as="li" key={step.title} className="mx-step">
                  <div className="mx-step-top">
                    <span className="mx-step-icon">
                      <step.icon aria-hidden="true" />
                    </span>
                    <span className="mx-step-num">0{index + 1}</span>
                  </div>
                  <h3 className="mx-step-title">{step.title}</h3>
                  <p className="mx-step-body">{step.body}</p>
                </Reveal>
              ))}
            </ol>
          </div>
        </section>

        <section id="product" className="mx-section">
          <div className="mx-wrap">
            <Reveal focus>
              <p className="mx-section-eyebrow">01 — Product</p>
              <h2 className="mx-title">Built for the controls an auditor will ask about</h2>
              <p className="mx-section-body">
                Speed matters, but so does being able to explain every decision. Each feature below leaves a trace.
              </p>
            </Reveal>
            <div className="mx-features">
              {FEATURES.map((feature) => (
                <Reveal as="article" key={feature.title} className={`mx-feature${feature.span ? ' mx-feature-wide' : ''}`}>
                  <span className="mx-feature-icon">
                    <feature.icon aria-hidden="true" />
                  </span>
                  <h3 className="mx-feature-title">{feature.title}</h3>
                  <p className="mx-feature-body">{feature.body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section id="safety" className="mx-section">
          <div className="mx-wrap mx-safety-grid">
            <Reveal focus>
              <p className="mx-section-eyebrow">03 — Safety model</p>
              <h2 className="mx-title">The AI can only say “wait.”</h2>
              <p className="mx-section-body">
                Most AP tools trust a model with the decision. InvoiceIQ treats the model as an untrusted advisor and
                enforces that rule in code, not in a prompt.
              </p>
            </Reveal>
            <ul className="mx-safety-list">
              {SAFETY.map(([title, body]) => (
                <Reveal as="li" key={title} className="mx-safety-row">
                  <span className="mx-safety-icon">
                    <Lock aria-hidden="true" />
                  </span>
                  <div>
                    <h3 className="mx-safety-title">{title}</h3>
                    <p className="mx-safety-body">{body}</p>
                  </div>
                </Reveal>
              ))}
            </ul>
          </div>
        </section>

        <section className="mx-section">
          <div className="mx-wrap">
            <Reveal focus>
              <p className="mx-section-eyebrow">04 — Who uses it</p>
              <h2 className="mx-title">One workflow, a clear job for every role</h2>
              <p className="mx-section-body">
                Each step belongs to a role, and every action is recorded in the audit log under the person who took it.
              </p>
            </Reveal>
            <div className="mx-roles">
              {ROLES.map((item) => (
                <Reveal key={item.role} className="mx-role">
                  <h3 className="mx-role-title">{item.role}</h3>
                  <p className="mx-role-body">{item.body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-section mx-closing">
          <div className="mx-wrap mx-closing-inner">
            <Reveal focus>
              <p className="mx-section-eyebrow">Get started</p>
              <h2 className="mx-title mx-closing-title">
                Put a safety layer between every invoice and your bank account.
              </h2>
              <p className="mx-section-body mx-closing-body">
                Start with one invoice and see every check it passes through before anything is paid.
              </p>
            </Reveal>
            <div className="mx-closing-actions">
              <Link href="/login?tab=signup" className="mx-btn-primary">
                Create your account
                <ArrowRight className="mx-btn-icon" aria-hidden="true" />
              </Link>
              <Link href="/login" className="mx-btn-ghost">
                Sign in
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="mx-footer">
        <div className="mx-wrap mx-footer-inner">
          <Image src="/brand/logo-light.png" alt="InvoiceIQ" width={800} height={267} className="mx-logo" />
          <nav aria-label="Footer" className="mx-footer-nav">
            <a href="#product">Product</a>
            <a href="#safety">Safety</a>
            <Link href="/login">Sign in</Link>
            <Link href="/login?tab=signup">Create account</Link>
          </nav>
          <p className="mx-footer-copy">&copy; {new Date().getFullYear()} InvoiceIQ</p>
          <a href="#main-content" className="mx-top">
            Back to top
            <ArrowUp className="mx-btn-icon" aria-hidden="true" />
          </a>
        </div>
      </footer>
    </div>
  );
}

function HeroPanel() {
  const fields = [
    { label: 'Total', value: '$12,480.00' },
    { label: 'Due', value: '30 Nov 2026' },
    { label: 'PO match', value: '3 of 3 lines' },
    { label: 'Duplicate check', value: 'No match' },
  ];
  const confidence = [
    { label: 'Vendor', pct: 99 },
    { label: 'Total', pct: 98 },
    { label: 'Tax ID', pct: 74 },
  ];
  const pipeline = ['Received', 'Extracted', 'Matched', 'Held', 'Approved'];
  const current = 3;

  return (
    <div className="mx-panel-wrap">
      <div className="mx-panel">
        <div className="mx-panel-head">
          <div>
            <p className="mx-panel-id">INV-2041</p>
            <p className="mx-panel-vendor">Northwind Supplies Ltd.</p>
          </div>
          <span className="mx-panel-badge">On hold</span>
        </div>

        <div className="mx-panel-alert">
          <ShieldAlert className="mx-panel-alert-icon" aria-hidden="true" />
          <p>Bank details changed 3 days ago. Payment is quarantined until the change is verified.</p>
        </div>

        <dl className="mx-panel-fields">
          {fields.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>

        <div className="mx-panel-confidence">
          <p className="mx-panel-label">AI confidence</p>
          {confidence.map((item) => (
            <div key={item.label} className="mx-bar-row">
              <span className="mx-bar-name">{item.label}</span>
              <div className="mx-bar-track">
                <div
                  className={`mx-bar-fill${item.pct < 90 ? ' mx-bar-fill-warn' : ''}`}
                  style={{ width: `${item.pct}%` }}
                />
              </div>
              <span className="mx-bar-pct">{item.pct}%</span>
            </div>
          ))}
        </div>

        <ol className="mx-pipeline">
          {pipeline.map((stage, index) => {
            const done = index < current;
            const active = index === current;
            return (
              <li key={stage}>
                <span className={`mx-pipeline-bar${done ? ' mx-pipeline-done' : ''}${active ? ' mx-pipeline-active' : ''}`} />
                <span className={`mx-pipeline-stage${active ? ' mx-pipeline-stage-active' : ''}${done ? ' mx-pipeline-stage-done' : ''}`}>
                  {stage}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="mx-panel-caption">Illustrative example</p>
    </div>
  );
}
