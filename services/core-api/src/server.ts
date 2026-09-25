import { loadConfig } from './config.js';
import { startRuntime } from './runtime.js';

const config = loadConfig();
const runtime = await startRuntime(config);

await runtime.app.listen({ port: config.PORT, host: config.HOST });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    runtime.app.log.info({ signal }, 'shutting down');
    runtime.close().then(
      () => process.exit(0),
      (err: unknown) => {
        runtime.app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}
