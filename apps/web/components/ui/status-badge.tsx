import type { InvoiceState } from '../../lib/api';
import { STATE_LABEL } from '../../lib/format';
import { Badge } from './badge';

const TONE: Record<InvoiceState, 'neutral' | 'pending' | 'hold' | 'exception' | 'queued' | 'success'> = {
  RECEIVED: 'neutral',
  EXTRACTING: 'neutral',
  EXTRACTED: 'neutral',
  VALIDATING: 'neutral',
  VALIDATED: 'neutral',
  MATCHING: 'neutral',
  MATCHED: 'neutral',
  PENDING_APPROVAL: 'pending',
  APPROVED: 'success',
  PAYMENT_QUEUED: 'queued',
  PAID: 'success',
  HOLD: 'hold',
  EXCEPTION: 'exception',
  REJECTED: 'hold',
};

export function StatusBadge({ state }: { state: InvoiceState }) {
  return <Badge tone={TONE[state]}>{STATE_LABEL[state]}</Badge>;
}
