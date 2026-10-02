// Armazenamento em memória: só para desenvolvimento/testes. Em produção use DATABASE_URL (Postgres).
export class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.orders = new Map();
    this.leads = new Map();
    this.events = new Set();
  }
  async init() {}
  async close() {}

  async insertOrder(order) {
    this.orders.set(order.id, structuredClone(order));
    return order;
  }
  async getOrder(id) {
    const o = this.orders.get(id);
    return o ? structuredClone(o) : null;
  }
  async saveOrder(order) {
    order.updatedAt = new Date().toISOString();
    this.orders.set(order.id, structuredClone(order));
    return order;
  }
  async findOrderByAdexId(adexId) {
    for (const o of this.orders.values()) if (o.adex?.transactionId === adexId) return structuredClone(o);
    return null;
  }
  async findOrderByKey(key) {
    for (const o of this.orders.values()) if (o.idempotencyKey === key) return structuredClone(o);
    return null;
  }
  async listOrders({ status, limit = 200 } = {}) {
    return [...this.orders.values()]
      .filter((o) => !status || o.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((o) => structuredClone(o));
  }

  async saveLead(lead) {
    lead.updatedAt = new Date().toISOString();
    this.leads.set(lead.id, structuredClone(lead));
    return lead;
  }
  async getLead(id) {
    const l = this.leads.get(id);
    return l ? structuredClone(l) : null;
  }
  async listLeads({ limit = 200 } = {}) {
    return [...this.leads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map((l) => structuredClone(l));
  }

  /** true se o evento é novo (idempotência de webhook). */
  async recordEvent(key) {
    if (this.events.has(key)) return false;
    this.events.add(key);
    return true;
  }
  async ping() {
    return true;
  }
}
