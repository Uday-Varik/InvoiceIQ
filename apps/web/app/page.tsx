import { groupReasons, reasonViews, stateViews } from '../lib/catalog';

export default function Home() {
  const groups = groupReasons(reasonViews());
  return (
    <main>
      <h1>InvoiceIQ</h1>
      <p>
        Phase 0 shell. The lifecycle and reason catalog below are read from the generated contract catalog, so this page
        can never disagree with core-api.
      </p>
      <h2>Invoice lifecycle</h2>
      <ul>
        {stateViews().map((s) => (
          <li key={s.state}>
            <code>{s.state}</code> {s.terminal ? '(terminal)' : `→ ${s.next.join(', ')}`}
          </li>
        ))}
      </ul>
      <h2>Reason codes</h2>
      {Object.entries(groups).map(([group, items]) => (
        <section key={group}>
          <h3>{group}</h3>
          <ul>
            {items.map((r) => (
              <li key={r.code}>
                <code>{r.code}</code> ({r.severity}) → {r.allowedOutcomes.join(' / ')}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
