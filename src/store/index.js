import { MemoryStore } from './memory.js';
import { PostgresStore } from './postgres.js';

export function createStore(config, log = console) {
  if (config.databaseUrl) return new PostgresStore(config.databaseUrl);
  if (config.isProd) {
    log.error('[store] DATABASE_URL ausente em produção: pedidos ficariam só na memória e SE PERDEM a cada deploy. Adicione o PostgreSQL no Railway.');
  } else {
    log.warn('[store] DATABASE_URL ausente: usando memória (apenas desenvolvimento).');
  }
  return new MemoryStore();
}
