import { groupReasons, reasonViews, stateViews } from '../../lib/catalog';
import { PageHeader } from '../../components/page-header';
import { Card } from '../../components/ui/card';
import { Table, TableCell, TableHead, TableRow } from '../../components/ui/table';

export default function Lifecycle() {
  const groups = groupReasons(reasonViews());
  return (
    <div className="space-y-6">
      <PageHeader
        title="Invoice states"
        description="Where an invoice can go next, and why it might stop. Read from the generated contract catalog, so this page matches the API."
      />
      <Card className="p-5">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Lifecycle</h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {stateViews().map((s) => (
            <li key={s.state} className="rounded-lg border border-border p-3 text-sm">
              <code className="font-mono text-xs font-semibold">{s.state}</code>
              <p className="mt-1 text-muted-foreground">{s.terminal ? 'Final state' : `Can move to ${s.next.join(', ')}`}</p>
            </li>
          ))}
        </ul>
      </Card>
      {Object.entries(groups).map(([group, items]) => (
        <Card key={group} className="overflow-x-auto">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">{group}</h2>
          </div>
          <Table>
            <thead>
              <tr>
                <TableHead>Code</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Result</TableHead>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <TableRow key={r.code}>
                  <TableCell>
                    <code className="font-mono text-xs">{r.code}</code>
                  </TableCell>
                  <TableCell className="capitalize">{r.severity}</TableCell>
                  <TableCell>{r.allowedOutcomes.join(' or ')}</TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </Card>
      ))}
    </div>
  );
}
