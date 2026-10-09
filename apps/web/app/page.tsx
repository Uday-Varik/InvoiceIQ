import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
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

const FEATURES: { icon: LucideIcon; title: string; body: string; span: string }[] = [
  {
    icon: FileSearch,
    title: 'AI extraction that shows its work',
    body: 'Every extracted field carries a confidence score. Anything uncertain goes to a reviewer, with the source text beside it.',
    span: 'md:col-span-2',
  },
  {
    icon: Copy,
    title: 'Duplicate detection',
    body: 'Invoices that match an earlier one are flagged before they can reach a payment run.',
    span: '',
  },
  {
    icon: Landmark,
    title: 'Bank-change quarantine',
    body: 'When a vendor’s bank details change, payments to that vendor are held until someone verifies the change.',
    span: '',
  },
  {
    icon: Building2,
    title: 'Multi-tier approvals',
    body: 'Route by amount, vendor or category. Clerks capture, managers approve, controllers release payment runs.',
    span: '',
  },
  {
    icon: Wallet,
    title: 'Payment runs',
    body: 'Batch approved invoices into a run and follow it from queued through execution to reconciliation.',
    span: '',
  },
  {
    icon: ScrollText,
    title: 'Tamper-evident audit log',
    body: 'Every action is hash-chained to the one before it. Editing history breaks the chain, so auditors can verify it.',
    span: 'md:col-span-2',
  },
];

const ROLES = [
  { role: 'AP clerk', body: 'Uploads invoices, corrects extracted fields and clears the simple cases.' },
  { role: 'AP manager', body: 'Reviews held invoices and approves within their tier, with the reason on screen.' },
  { role: 'Controller', body: 'Releases payment runs and resolves bank-change and duplicate holds.' },
  { role: 'CFO', body: 'Sees spend, approval turnaround and audit status without digging through inboxes.' },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b border-white/10 bg-[#0a1d3b]/85 text-white backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5">
          <Link href="/" aria-label="InvoiceIQ home" className="shrink-0">
            <Image src="/brand/logo-light.png" alt="InvoiceIQ" width={800} height={267} className="h-7 w-auto" priority />
          </Link>
          <nav aria-label="Primary" className="hidden items-center gap-7 text-sm text-white/70 md:flex">
            <a href="#product" className="transition-colors hover:text-white">Product</a>
            <a href="#how-it-works" className="transition-colors hover:text-white">How it works</a>
            <a href="#safety" className="transition-colors hover:text-white">Safety</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/login" className="rounded-md px-3 py-1.5 text-sm text-white/80 transition-colors hover:text-white">
              Sign in
            </Link>
            <Link
              href="/login?tab=signup"
              className="rounded-md bg-[#2dd4bf] px-3.5 py-1.5 text-sm font-semibold text-[#052e2b] transition-colors hover:bg-[#5eead4]"
            >
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main id="main-content">
        <section className="relative isolate overflow-hidden bg-[#0a1d3b] text-white">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_80%_20%,rgba(45,212,191,0.22),transparent_45%),radial-gradient(circle_at_10%_90%,rgba(59,130,246,0.18),transparent_40%)]"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]"
          />

          <div className="mx-auto grid max-w-6xl items-center gap-14 px-5 pb-20 pt-16 md:pb-28 md:pt-24 lg:grid-cols-[1.05fr_0.95fr]">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-white/80">
                <span className="size-1.5 rounded-full bg-[#2dd4bf]" />
                AI reads. Controls decide. People approve.
              </p>
              <h1 className="mt-6 text-4xl font-semibold leading-[1.05] tracking-tight text-balance sm:text-5xl lg:text-6xl">
                Pay every invoice <span className="bg-linear-to-r from-[#5eead4] to-[#60a5fa] bg-clip-text text-transparent">right the first time.</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/70 text-pretty">
                InvoiceIQ extracts every field from your invoices, matches them to purchase orders and holds anything
                suspicious before money moves. Our AI can slow a payment down. It cannot speed one up.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Link
                  href="/login?tab=signup"
                  className="inline-flex items-center gap-2 rounded-lg bg-[#2dd4bf] px-5 py-3 text-sm font-semibold text-[#052e2b] shadow-lg shadow-teal-500/20 transition-colors hover:bg-[#5eead4]"
                >
                  Create your account
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
                <a
                  href="#how-it-works"
                  className="inline-flex items-center gap-2 rounded-lg border border-white/20 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-white/10"
                >
                  See how it works
                </a>
              </div>
              <p className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-sm text-white/55">
                {['Duplicate detection', 'Bank-change quarantine', 'Hash-chained audit log'].map((item) => (
                  <span key={item} className="inline-flex items-center gap-1.5">
                    <Check className="size-3.5 text-[#2dd4bf]" aria-hidden="true" />
                    {item}
                  </span>
                ))}
              </p>
            </div>

            <HeroPanel />
          </div>
        </section>

        <section aria-label="Key numbers" className="border-b border-border bg-card">
          <dl className="mx-auto grid max-w-6xl grid-cols-2 gap-px bg-border md:grid-cols-4">
            {STATS.map((stat) => (
              <div key={stat.value} className="bg-card px-5 py-8">
                <dd className="text-4xl font-semibold tracking-tight tabular-nums">{stat.value}</dd>
                <dt className="mt-2 text-sm leading-snug text-muted-foreground">{stat.label}</dt>
              </div>
            ))}
          </dl>
        </section>

        <section id="how-it-works" className="scroll-mt-20 mx-auto max-w-6xl px-5 py-20 md:py-28">
          <SectionHeading
            eyebrow="How it works"
            title="From a stack of PDFs to a payment run in four steps"
            body="Each step has a clear owner and a visible result. Nothing skips a step, and nothing is hidden from the audit log."
          />
          <ol className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-4">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex flex-col bg-card p-7">
                <div className="flex items-center justify-between">
                  <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
                    <step.icon className="size-5" aria-hidden="true" />
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">0{index + 1}</span>
                </div>
                <h3 className="mt-6 text-lg font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="product" className="scroll-mt-20 border-y border-border bg-muted/40">
          <div className="mx-auto max-w-6xl px-5 py-20 md:py-28">
            <SectionHeading
              eyebrow="Product"
              title="Built for the controls an auditor will ask about"
              body="Speed matters, but so does being able to explain every decision. Each feature below leaves a trace."
            />
            <div className="mt-14 grid gap-4 md:grid-cols-3">
              {FEATURES.map((feature) => (
                <article
                  key={feature.title}
                  className={`${feature.span} group rounded-2xl border border-border bg-card p-7 shadow-sm transition-shadow hover:shadow-md`}
                >
                  <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                    <feature.icon className="size-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-6 text-lg font-semibold">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{feature.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="safety" className="scroll-mt-20 mx-auto max-w-6xl px-5 py-20 md:py-28">
          <div className="grid items-start gap-14 lg:grid-cols-2">
            <div>
              <SectionHeading
                eyebrow="Safety model"
                title="The AI can only say “wait.”"
                body="Most AP tools trust a model with the decision. InvoiceIQ treats the model as an untrusted advisor and enforces that rule in code, not in a prompt."
                align="left"
              />
            </div>
            <ul className="space-y-4">
              {[
                ['Type system', 'AI reason codes accept exactly one outcome: HOLD. Any other outcome fails to compile.'],
                ['Lifecycle gate', 'The state machine refuses any AI-driven transition except into HOLD. Tests replay 200 AI-driven invoices and none reach payment.'],
                ['API contract', 'The signal schema allows only HOLD in OpenAPI, Zod and Pydantic, so the contract cannot drift.'],
                ['Import rules', 'The AI service has no database credentials and cannot load database drivers. CI enforces that boundary.'],
              ].map(([title, body]) => (
                <li key={title} className="flex gap-4 rounded-xl border border-border bg-card p-5">
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-[#0a1d3b] text-[#2dd4bf]">
                    <Lock className="size-4" aria-hidden="true" />
                  </span>
                  <div>
                    <h3 className="font-semibold">{title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="border-y border-border bg-card">
          <div className="mx-auto max-w-6xl px-5 py-20 md:py-24">
            <SectionHeading
              eyebrow="Who uses it"
              title="One workflow, a clear job for every role"
              body="Each step belongs to a role, and every action is recorded in the audit log under the person who took it."
            />
            <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
              {ROLES.map((item) => (
                <div key={item.role} className="bg-card p-6">
                  <h3 className="font-semibold">{item.role}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-20 md:py-28">
          <div className="relative isolate overflow-hidden rounded-3xl bg-[#0a1d3b] px-6 py-16 text-center text-white md:px-16">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_0%,rgba(45,212,191,0.25),transparent_60%)]"
            />
            <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight text-balance md:text-4xl">
              Put a safety layer between every invoice and your bank account.
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-white/70 text-pretty">
              Start with one invoice and see every check it passes through before anything is paid.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              <Link
                href="/login?tab=signup"
                className="inline-flex items-center gap-2 rounded-lg bg-[#2dd4bf] px-6 py-3 text-sm font-semibold text-[#052e2b] transition-colors hover:bg-[#5eead4]"
              >
                Create your account
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center rounded-lg border border-white/20 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-white/10"
              >
                Sign in
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-5 py-10 md:flex-row md:items-center">
          <Image src="/brand/logo.png" alt="InvoiceIQ" width={800} height={267} className="h-6 w-auto" />
          <nav aria-label="Footer" className="flex flex-wrap gap-6 text-sm text-muted-foreground">
            <a href="#product" className="hover:text-foreground">Product</a>
            <a href="#safety" className="hover:text-foreground">Safety</a>
            <Link href="/login" className="hover:text-foreground">Sign in</Link>
            <Link href="/login?tab=signup" className="hover:text-foreground">Create account</Link>
          </nav>
          <p className="text-sm text-muted-foreground">&copy; {new Date().getFullYear()} InvoiceIQ</p>
        </div>
      </footer>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  body,
  align = 'center',
}: {
  eyebrow: string;
  title: string;
  body: string;
  align?: 'center' | 'left';
}) {
  const alignment = align === 'center' ? 'mx-auto text-center' : '';
  return (
    <div className={`max-w-2xl ${alignment}`}>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance md:text-4xl">{title}</h2>
      <p className="mt-4 text-base leading-relaxed text-muted-foreground text-pretty">{body}</p>
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
    <div className="relative">
      <div className="rounded-2xl border border-white/10 bg-[#0f2547]/80 p-5 shadow-2xl shadow-black/40 backdrop-blur md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-xs text-white/50">INV-2041</p>
            <p className="mt-1 font-semibold">Northwind Supplies Ltd.</p>
          </div>
          <span className="rounded-full bg-amber-400/15 px-2.5 py-1 text-xs font-semibold text-amber-300 ring-1 ring-inset ring-amber-400/30">
            On hold
          </span>
        </div>

        <div className="mt-5 flex gap-3 rounded-xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-100">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
          <p className="leading-relaxed">
            Bank details changed 3 days ago. Payment is quarantined until the change is verified.
          </p>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4">
          {fields.map((field) => (
            <div key={field.label}>
              <dt className="text-xs text-white/50">{field.label}</dt>
              <dd className="mt-1 font-medium tabular-nums">{field.value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-6 space-y-3">
          <p className="text-xs font-medium uppercase tracking-wider text-white/45">AI confidence</p>
          {confidence.map((item) => (
            <div key={item.label} className="flex items-center gap-3 text-sm">
              <span className="w-14 shrink-0 text-white/60">{item.label}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className={`h-full rounded-full ${item.pct < 90 ? 'bg-amber-400' : 'bg-[#2dd4bf]'}`}
                  style={{ width: `${item.pct}%` }}
                />
              </div>
              <span className="w-9 text-right tabular-nums text-white/60">{item.pct}%</span>
            </div>
          ))}
        </div>

        <ol className="mt-6 grid grid-cols-5 gap-1.5 border-t border-white/10 pt-5">
          {pipeline.map((stage, index) => {
            const done = index < current;
            const active = index === current;
            return (
              <li key={stage} className="text-center">
                <span
                  className={`mx-auto block h-1 rounded-full ${
                    done ? 'bg-[#2dd4bf]' : active ? 'bg-amber-400' : 'bg-white/10'
                  }`}
                />
                <span className={`mt-2 block text-[11px] leading-tight ${active ? 'text-amber-200' : done ? 'text-white/70' : 'text-white/35'}`}>
                  {stage}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="mt-3 text-center text-xs text-white/40">Illustrative example</p>
    </div>
  );
}
