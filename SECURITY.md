# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a
vulnerability** button on this repository (Security tab), not in public
issues. Include steps to reproduce and the impact you expect. You will get an
acknowledgement within 72 hours.

## What counts

We especially want to hear about anything that could:

- move an invoice toward payment without the required human decision,
- let an AI-derived signal do anything other than HOLD,
- read or write another tenant's data,
- alter the audit ledger without breaking verification,
- bypass the vendor bank-change quarantine.

## Design posture

- Threat model: [docs/threat-model/README.md](docs/threat-model/README.md)
  (STRIDE, 26 threats, 8 abuse cases).
- AI has no payment authority: [ADR-0007](docs/adr/0007-ai-no-payment-authority.md).
- Tenant isolation with forced row-level security: [ADR-0004](docs/adr/0004-rls-multi-tenancy.md).
- Tamper-evident audit log: [ADR-0009](docs/adr/0009-hash-chained-audit-log.md).
- Supply chain: GitHub Actions pinned by commit SHA, exact dependency
  versions, committed lockfiles, Dependabot.

## Supported versions

Pre-release. Only `main` receives fixes.
