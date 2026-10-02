// Armazenamento em Postgres (Railway: adicione o plugin PostgreSQL; ele injeta DATABASE_URL).
import pg from 'pg';

export class PostgresStore {
  constructor(databaseUrl) {
    this.kind = 'postgres';
    const local = /localhost|127\.0\.0\.1/.test(databaseUrl);
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
      ssl: local || /sslmode=disable/.test(databaseUrl) ? false : { rejectUnauthorized: false },
    });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id          text PRIMARY KEY,
        status      text NOT NULL,
        adex_id     text,
        idem_key    text,
        data        jsonb NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS orders_adex_id_idx ON orders (adex_id) WHERE adex_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS orders_idem_key_idx ON orders (idem_key) WHERE idem_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, created_at DESC);
      CREATE TABLE IF NOT EXISTS leads (
        id          text PRIMARY KEY,
        data        jsonb NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS webhook_events (
        key         text PRIMARY KEY,
        received_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
  async close() {
    await this.pool.end();
  }
  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }

  async insertOrder(o) {
    await this.pool.query(
      `INSERT INTO orders (id, status, adex_id, idem_key, data, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [o.id, o.status, o.adex?.transactionId ?? null, o.idempotencyKey ?? null, o, o.createdAt]
    );
    return o;
  }
  async getOrder(id) {
    const r = await this.pool.query('SELECT data FROM orders WHERE id = $1', [id]);
    return r.rows[0]?.data ?? null;
  }
  async saveOrder(o) {
    o.updatedAt = new Date().toISOString();
    await this.pool.query(
      `UPDATE orders SET status=$2, adex_id=$3, data=$4, updated_at=now() WHERE id=$1`,
      [o.id, o.status, o.adex?.transactionId ?? null, o]
    );
    return o;
  }
  async findOrderByAdexId(adexId) {
    const r = await this.pool.query('SELECT data FROM orders WHERE adex_id = $1', [adexId]);
    return r.rows[0]?.data ?? null;
  }
  async findOrderByKey(key) {
    const r = await this.pool.query('SELECT data FROM orders WHERE idem_key = $1', [key]);
    return r.rows[0]?.data ?? null;
  }
  async listOrders({ status, limit = 200 } = {}) {
    const r = status
      ? await this.pool.query('SELECT data FROM orders WHERE status=$1 ORDER BY created_at DESC LIMIT $2', [status, limit])
      : await this.pool.query('SELECT data FROM orders ORDER BY created_at DESC LIMIT $1', [limit]);
    return r.rows.map((x) => x.data);
  }

  async saveLead(l) {
    l.updatedAt = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO leads (id, data, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [l.id, l]
    );
    return l;
  }
  async getLead(id) {
    const r = await this.pool.query('SELECT data FROM leads WHERE id = $1', [id]);
    return r.rows[0]?.data ?? null;
  }
  async listLeads({ limit = 200 } = {}) {
    const r = await this.pool.query('SELECT data FROM leads ORDER BY updated_at DESC LIMIT $1', [limit]);
    return r.rows.map((x) => x.data);
  }

  async recordEvent(key) {
    const r = await this.pool.query('INSERT INTO webhook_events (key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
    return r.rowCount === 1;
  }
}
