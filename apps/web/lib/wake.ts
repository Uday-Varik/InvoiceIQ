/**
 * The demo runs on free tiers that scale to zero, so the first request after
 * idle can take a minute while core-api (and then ai-service) boot. This polls
 * core-api's /healthz and reports progress so the UI can say "waking the demo"
 * instead of looking broken.
 */

export type BackendStatus = 'checking' | 'waking' | 'ready' | 'down';

export interface WakeOptions {
  readonly url: string;
  readonly fetchFn?: typeof fetch;
  /** Show "waking" if the first check has not succeeded by then. */
  readonly slowAfterMs?: number;
  readonly retryEveryMs?: number;
  readonly attemptTimeoutMs?: number;
  readonly giveUpAfterMs?: number;
  readonly onStatus: (status: BackendStatus) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function healthy(url: string, fetchFn: typeof fetch, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetchFn(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === 'ok';
  } catch {
    return false;
  }
}

export async function waitForBackend(opts: WakeOptions): Promise<BackendStatus> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const start = now();
  const slowAfter = opts.slowAfterMs ?? 1_500;
  const giveUp = opts.giveUpAfterMs ?? 180_000;
  let status: BackendStatus = 'checking';
  const set = (s: BackendStatus) => {
    if (s !== status) {
      status = s;
      opts.onStatus(s);
    }
  };
  opts.onStatus(status);
  const slowTimer = setTimeout(() => {
    if (status === 'checking') set('waking');
  }, slowAfter);
  try {
    while (!opts.signal?.aborted) {
      if (await healthy(opts.url, fetchFn, opts.attemptTimeoutMs ?? 15_000)) {
        set('ready');
        return 'ready';
      }
      if (status === 'checking') set('waking');
      if (now() - start >= giveUp) {
        set('down');
        return 'down';
      }
      await sleep(opts.retryEveryMs ?? 3_000);
    }
    return status;
  } finally {
    clearTimeout(slowTimer);
  }
}
