'use client';

import { useEffect, useState } from 'react';
import type { Invoice } from '../lib/api';
import { formatElapsed, PIPELINE_STEPS, pipelineStep, progressHint } from '../lib/format';

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
    <div className="progress">
      <ol className="progress-steps" aria-label="Processing steps">
        {PIPELINE_STEPS.map((label, i) => {
          const status = i < step ? 'done' : i === step ? 'current' : 'todo';
          return (
            <li key={label} className={`progress-step progress-step-${status}`} aria-current={status === 'current' ? 'step' : undefined}>
              {status === 'current' ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <span className="progress-mark" aria-hidden="true">
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
      <div className="progress-bar" aria-hidden="true" />
      <p className="muted small progress-meta">
        <span className="sr-only" role="status">
          {PIPELINE_STEPS[step]}
        </span>
        {formatElapsed(elapsed)} so far.{hint && ` ${hint}`}
      </p>
    </div>
  );
}
