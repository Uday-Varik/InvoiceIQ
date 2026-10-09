'use client';

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card className="mx-auto max-w-md space-y-4 border-rose-200 p-8 text-center dark:border-rose-400/30">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">An unexpected error occurred. This has been logged. Your invoices have not changed.</p>
      <div>
        <Button onClick={reset}>Try again</Button>
      </div>
    </Card>
  );
}
