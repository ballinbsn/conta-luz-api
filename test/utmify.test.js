import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { startMockAdex } from '../scripts/mock-adex.js';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';
import { AdexClient } from '../src/adex.js';
import { UtmifyClient, buildPayload, utcStamp } from '../src/utmify.js';
import { createApp } from '../src/app.js';

const quiet = { log() {}, warn() {}, error() {} };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const wait = async (cond, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

function startMockUtmify({ failTimes = 0, status = 500 } = {}) {
  const calls = [];
  let fails = failTimes;
  const server = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      calls.push({ path: req.url, token: req.headers['x-api-token'], body: d ? JSON.parse(d) : null });
      if (fails > 0) { fails--; res.writeHead(status); return res.end('erro'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"success":true}');
    });
  });
  return new Promise((r) => server.listen(0, () => r({ url: `http://localhost:${server.address().port}`, calls, close: () => new Promise((x) => server.close(x)) })));
}

const order = (extra = {}) => ({
  slug: 'ecovolt-2',
  idempotencyKey: crypto.randomUUID(),
  customer: { name: 'Maria da Silva', email: 'maria@email.com', phone: '(11) 99999-9999', cpf: '529.982.247-25' },
  address: { cep: '01310-100', street: 'Av. Paulista', number: '1000', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP' },
  shippingId: 'sedex',
  tracking: { utm_source: 'FB', utm_campaign: 'CAMP|123', utm_medium: 'CONJ|456', utm_content: 'ANUNCIO|789', fbclid: 'xyz' },
  ...extra,
});

async function boot({ utmifyOpts = {}, token = 'tok_teste' } = {}) {
  const adexMock = await startMockAdex({});
  const um = await startMockUtmify(utmifyOpts);
  const port = await freePort();
  const config = loadConfig({ PORT: String(port), PUBLIC_URL: `http://localhost:${port}`, ADEX_BASE_URL: adexMock.url, ADEX_PUBLIC_KEY: 'pk_test_x', ADEX_SECRET_KEY: 'sk_test_x', UTMIFY_API_TOKEN: token, UTMIFY_BASE_URL: um.url });
  const store = new MemoryStore();
  const utmify = new UtmifyClient({ ...config.utmify, retryDelaysMs: [5, 5] });
  const app = createApp({ config, store, adex: new AdexClient(config.adex), utmify, log: quiet });
  const server = await new Promise((r) => { const s = app.listen(port, () => r(s)); });
  const base = `http://localhost:${port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { base, post, store, adexMock, um, close: async () => { await new Promise((r) => server.close(r)); await adexMock.close(); await um.close(); } };
}

test('Utmify: formato do payload (datas UTC, centavos, tracking, frete como item)', async () => {
  const t = await boot();
  try {
    const r = await (await t.post('/api/orders', order())).json();
    assert.ok(await wait(() => t.um.calls.length >= 1), 'deve enviar waiting_payment');
    const c = t.um.calls[0];
    assert.equal(c.path, '/api-credentials/orders');
    assert.equal(c.token, 'tok_teste');
    const b = c.body;
    assert.equal(b.status, 'waiting_payment');
    assert.equal(b.orderId, r.order.id);
    assert.equal(b.paymentMethod, 'pix');
    assert.match(b.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(b.approvedDate, null);
    assert.equal(b.refundedAt, null);
    assert.equal(b.customer.document, '52998224725');
    assert.equal(b.customer.phone, '11999999999');
    assert.equal(b.customer.country, 'BR');
    assert.deepEqual(b.products.map((p) => p.priceInCents), [9700, 1852]);
    assert.equal(b.commission.totalPriceInCents, 11552);
    assert.equal(b.commission.userCommissionInCents, 11552);
    assert.equal(b.trackingParameters.utm_source, 'FB');
    assert.equal(b.trackingParameters.utm_campaign, 'CAMP|123');
    assert.equal(b.trackingParameters.utm_term, null);
    assert.equal(b.isTest, false);
  } finally { await t.close(); }
});

test('Utmify: paga -> envia "paid" uma única vez (webhook + polling não duplicam)', async () => {
  const t = await boot();
  try {
    const r = await (await t.post('/api/orders', order())).json();
    assert.ok(await wait(() => t.um.calls.length >= 1));
    const o = await t.store.getOrder(r.order.id);
    await fetch(`${t.adexMock.url}/__pay/${o.adex.transactionId}`); // dispara webhook assinado
    assert.ok(await wait(() => t.um.calls.some((c) => c.body.status === 'paid')), 'deve enviar paid');
    // polling logo depois não pode reenviar
    const o2 = await t.store.getOrder(r.order.id); o2.adex.lastCheckedAt = null; await t.store.saveOrder(o2);
    await fetch(`${t.base}/api/orders/${r.order.id}?t=${r.accessToken}`);
    await new Promise((x) => setTimeout(x, 150));
    assert.equal(t.um.calls.filter((c) => c.body.status === 'paid').length, 1);
    const paid = t.um.calls.find((c) => c.body.status === 'paid').body;
    assert.match(paid.approvedDate, /^\d{4}-\d{2}-\d{2} /);
  } finally { await t.close(); }
});

test('Utmify: falha temporária é repetida e não derruba o pedido', async () => {
  const t = await boot({ utmifyOpts: { failTimes: 2, status: 503 } });
  try {
    const res = await t.post('/api/orders', order());
    assert.equal(res.status, 201); // pedido não depende da Utmify
    assert.ok(await wait(() => t.um.calls.length >= 3), 'deve tentar 3 vezes');
    assert.ok(await wait(async () => (await t.store.listOrders())[0].utmify?.waiting_payment));
  } finally { await t.close(); }
});

test('Utmify: erro 4xx (token inválido) não repete e fica registrado', async () => {
  const t = await boot({ utmifyOpts: { failTimes: 99, status: 401 } });
  try {
    const res = await t.post('/api/orders', order());
    assert.equal(res.status, 201);
    assert.ok(await wait(async () => (await t.store.listOrders())[0].events.some((e) => e.type === 'utmify_failed:waiting_payment')));
    assert.equal(t.um.calls.length, 1);
  } finally { await t.close(); }
});

test('Utmify: sem token não envia nada', async () => {
  const t = await boot({ token: '' });
  try {
    assert.equal((await t.post('/api/orders', order())).status, 201);
    await new Promise((x) => setTimeout(x, 150));
    assert.equal(t.um.calls.length, 0);
  } finally { await t.close(); }
});

test('buildPayload: reembolso, taxa e IP privado', () => {
  const base = {
    id: 'o1', slug: 'ecovolt-1', createdAt: '2026-10-02T12:00:00.000Z', paidAt: '2026-10-02T12:05:00.000Z', ip: '10.0.0.4',
    offer: { name: 'ECOVOLT 1 UNIDADE' }, shipping: { id: 'gratis', name: 'Frete Grátis' }, totals: { subtotalCents: 4900, shippingCents: 0, totalCents: 4900 },
    customer: { name: 'A B', email: 'a@b.com', phone: '11999999999', cpf: '52998224725' }, tracking: {}, adex: { feeCents: 150 },
    events: [{ type: 'status:refunded', at: '2026-10-03T08:00:00.000Z' }],
  };
  const p = buildPayload(base, 'refunded', { platform: 'X', isTest: true });
  assert.equal(p.refundedAt, '2026-10-03 08:00:00');
  assert.equal(p.commission.gatewayFeeInCents, 150);
  assert.equal(p.commission.userCommissionInCents, 4750);
  assert.equal(p.customer.ip, undefined);
  assert.equal(p.products.length, 1);
  assert.equal(p.isTest, true);
  assert.equal(utcStamp('2026-01-02T03:04:05Z'), '2026-01-02 03:04:05');
});
