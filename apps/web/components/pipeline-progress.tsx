'use client';

import { useEffect, useState } from 'react';
import type { Invoice } from '../lib/api';
import { formatElapsed, PIPELINE_STEPS, pipelineStep, progressHint } from '../lib/format';
import { cn } from '../lib/utils';
import { Card } from './ui/card';

export function PipelineProgress({ invoice }: { invoice: Invoice }) {
  const step = pipelineStep(invoice.state);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (step === undefined) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [step]);

  if (step === undefined) return null;
  const elapsed = Math.max(0, now - Date.parse(invoice.createdAt));
  const hint = progressHint(elapsed);

  return (
    <Card className="space-y-3 p-4">
      <ol className="grid gap-2 sm:grid-cols-3" aria-label="Processing steps">
        {PIPELINE_STEPS.map((label, i) => {
          const status = i < step ? 'done' : i === step ? 'current' : 'todo';
          return (
            <li
              key={label}
              aria-current={status === 'current' ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 text-sm',
                status === 'todo' ? 'text-muted-foreground' : 'font-medium text-foreground',
              )}
            >
              {status === 'current' ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <span
                  aria-hidden="true"
                  className={cn(
                    'grid size-5 place-items-center rounded-full text-xs',
                    status === 'done' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300' : 'border border-border',
                  )}
                >
                  {status === 'done' ? '✓' : ''}
                </span>
              )}
              <span>
                {label}
                {status === 'done' && <span className="sr-only"> (done)</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="text-sm text-muted-foreground">
        <span className="sr-only" role="status">
          {PIPELINE_STEPS[step]}
        </span>
        {formatElapsed(elapsed)} so far.{hint && ` ${hint}`}
      </p>
    </Card>
  );
}
