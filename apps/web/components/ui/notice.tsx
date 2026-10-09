import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Notice({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        'rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200',
        className,
      )}
      {...props}
    />
  );
}
