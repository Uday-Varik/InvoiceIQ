# C4 level 2: containers

```mermaid
C4Container
  title InvoiceIQ containers
  Person(clerk, "AP clerk / approver")
  System_Boundary(iq, "InvoiceIQ") {
    Container(web, "apps/web", "Next.js, React", "Review queues, approvals, vendor admin")
    Container(core, "services/core-api", "TypeScript, Fastify", "Lifecycle gate, matching, duplicates, bank-change quarantine, audit ledger")
    Container(ai, "services/ai-service", "Python, FastAPI", "Extraction and HOLD-only signals; no DB credentials")
    ContainerDb(db, "Postgres", "RLS, queue, outbox, audit ledger")
  }
  System_Ext(llm, "Model provider")

  Rel(clerk, web, "HTTPS")
  Rel(web, core, "JSON over HTTPS", "core-api contract")
  Rel(core, ai, "JSON over HTTPS, service token", "ai-service contract")
  Rel(core, db, "SQL as app role under RLS")
  Rel(ai, llm, "Provider abstraction, record/replay in CI")
```

| Container | Can move money? | Holds DB credentials? |
| --- | --- | --- |
| apps/web | No (asks core-api) | No |
| core-api | Yes, through the lifecycle gate only | Yes (app role, RLS) |
| ai-service | No | No |
