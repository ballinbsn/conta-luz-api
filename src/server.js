import { loadConfig } from './config.js';
import { createStore } from './store/index.js';
import { AdexClient } from './adex.js';
import { createApp } from './app.js';

const config = loadConfig();
const store = createStore(config);
await store.init();

const adex = new AdexClient(config.adex);
if (!adex.configured) console.warn('[adex] ADEX_PUBLIC_KEY / ADEX_SECRET_KEY ausentes: o checkout abre, mas não gera PIX.');
if (config.isProd && !config.adminToken) console.warn('[admin] ADMIN_TOKEN ausente: endpoints /api/admin ficam desativados.');

const app = createApp({ config, store, adex });
const server = app.listen(config.port, () => {
  console.log(`[conta-luz-api] porta ${config.port} · store=${store.kind} · adex=${adex.configured ? 'ok' : 'sem chaves'} · ${config.publicUrl}`);
});

const shutdown = (sig) => {
  console.log(`[conta-luz-api] ${sig}: encerrando`);
  server.close(async () => {
    await store.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
