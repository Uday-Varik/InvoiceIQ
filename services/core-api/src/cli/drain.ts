import { httpAiClient } from '../clients/ai-service.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { createWorker } from '../runtime.js';
import type { WorkerLogger } from '../outbox/worker.js';

const consoleLogger: WorkerLogger = {
  info: (obj, msg) => console.log(msg, obj),
  warn: (obj, msg) => console.warn(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

/** One-shot drain for a scheduler (cron) when no request has woken core-api. */
const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const ai = httpAiClient({ baseUrl: config.AI_SERVICE_URL, signingSecret: config.AI_SIGNING_SECRET, timeoutMs: config.AI_TIMEOUT_MS });
try {
  const n = await createWorker(db, ai, { maxAttempts: config.OUTBOX_MAX_ATTEMPTS, log: consoleLogger }).drain();
  console.log(`drained ${n} outbox events`);
} finally {
  await db.end();
}
