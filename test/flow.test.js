import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startMockAdex } from '../scripts/mock-adex.js';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';
import { AdexClient } from '../src/adex.js';
import { createApp } from '../src/app.js';
import net from 'node:net';
import { pixAmountCents } from '../src/lib/emv.js';

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

const quiet = { log() {}, warn() {}, error() {} };
const CPF = '529.982.247-25';
let mock, server, base, store, config;

const validOrder = (extra = {}) => ({
  slug: 'ecovolt-2',
  idempotencyKey: crypto.randomUUID(),
  customer: { name: 'Maria da Silva', email: 'Maria@Email.com', phone: '(11) 99999-9999', cpf: CPF },
  address: { cep: '01310-100', street: 'Av. Paulista', number: '1000', complement: 'Apto 12', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP' },
  shippingId: 'gratis',
  tracking: { utm_source: 'fb', utm_campaign: 'teste', hack: 'x' },
  ...extra,
});
const api = (path, opts = {}) =>
  fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });

async function boot(mockOpts = {}, env = {}) {
  mock = await startMockAdex(mockOpts);
  const port = await freePort();
  config = loadConfig({
    PORT: String(port), PUBLIC_URL: `http://localhost:${port}`, ADMIN_TOKEN: 'admin-secret-123',
    ADEX_BASE_URL: mock.url, ADEX_PUBLIC_KEY: 'pk_test_x', ADEX_SECRET_KEY: 'sk_test_x', ...env,
  });
  store = new MemoryStore();
  const adex = new AdexClient(config.adex);
  const app = createApp({ config, store, adex, log: quiet });
  await new Promise((r) => (server = app.listen(port, r)));
  base = `http://localhost:${port}`;
}
async function shutdown() {
  await new Promise((r) => server.close(r));
  await mock.close();
}

before(() => boot());
after(shutdown);

test('GET /health e oferta', async () => {
  const h = await (await api('/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.adexConfigured, true);
  const o = await (await api('/api/offers/ecovolt-2-bk')).json();
  assert.equal(o.offer.priceCents, 9700);
  assert.equal(o.shipping.length, 3);
  assert.equal(o.paymentsReady, true);
  assert.equal((await api('/api/offers/xxx')).status, 404);
});

test('Cria PIX: valor do servidor, itens somam, chaves nos headers, postback', async () => {
  const res = await api('/api/orders', { method: 'POST', body: validOrder({ priceCents: 1, totalCents: 1, amount: 0.01 }) });
  assert.equal(res.status, 201);
  const j = await res.json();
  assert.equal(j.order.status, 'awaiting_payment');
  assert.equal(j.order.totals.totalCents, 9700);
  assert.match(j.order.pix.qrImage, /^data:image\/png;base64,/);
  assert.ok(j.order.pix.qrCode.startsWith('00020126'));
  assert.ok(j.accessToken.length >= 32);
  assert.equal(JSON.stringify(j).includes(CPF.replace(/\D/g, '')), false, 'CPF não deve voltar ao navegador');

  const call = mock.calls.filter((c) => c.path === '/pix-receive' && c.method === 'POST').at(-1);
  assert.equal(call.headers['x-public-key'], 'pk_test_x');
  assert.equal(call.headers['x-secret-key'], 'sk_test_x');
  assert.equal(call.body.amount, 97);
  assert.equal(call.body.customer.document.number, '52998224725');
  assert.equal(call.body.customer.email, 'maria@email.com');
  assert.equal(call.body.customer.phone, '11999999999');
  assert.equal(call.body.customer.address.zip, '01310100');
  assert.equal(call.body.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0).toFixed(2), '97.00');
  assert.equal(call.body.postbackUrl, `${base}/api/webhooks/adex`);
  assert.equal(call.body.external_id, (await store.listOrders())[0].id);
  const saved = (await store.listOrders())[0];
  assert.deepEqual(saved.tracking, { utm_source: 'fb', utm_campaign: 'teste' });
});

test('Frete Sedex entra como item e no total', async () => {
  const res = await api('/api/orders', { method: 'POST', body: validOrder({ shippingId: 'sedex' }) });
  const j = await res.json();
  assert.equal(j.order.totals.totalCents, 9700 + 1852);
  const call = mock.calls.filter((c) => c.path === '/pix-receive' && c.method === 'POST').at(-1);
  assert.equal(call.body.amount, 115.52);
  assert.equal(call.body.items.length, 2);
  assert.equal(call.body.items[1].tangible, false);
});

test('Validação: CPF inválido, frete inexistente, oferta inexistente', async () => {
  let r = await api('/api/orders', { method: 'POST', body: validOrder({ customer: { ...validOrder().customer, cpf: '111.111.111-11' } }) });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error.field, 'cpf');
  r = await api('/api/orders', { method: 'POST', body: validOrder({ shippingId: 'teletransporte' }) });
  assert.equal(r.status, 422);
  r = await api('/api/orders', { method: 'POST', body: validOrder({ slug: 'nada' }) });
  assert.equal(r.status, 404);
});

test('Idempotência: mesma chave não cria segunda cobrança', async () => {
  const body = validOrder();
  const before = mock.calls.filter((c) => c.path === '/pix-receive' && c.method === 'POST').length;
  const a = await (await api('/api/orders', { method: 'POST', body })).json();
  const b = await (await api('/api/orders', { method: 'POST', body })).json();
  assert.equal(a.order.id, b.order.id);
  assert.equal(mock.calls.filter((c) => c.path === '/pix-receive' && c.method === 'POST').length, before + 1);
});

test('Status: token obrigatório; polling detecta pagamento sem webhook', async () => {
  const c = await (await api('/api/orders', { method: 'POST', body: validOrder() })).json();
  const id = c.order.id;
  assert.equal((await api(`/api/orders/${id}`)).status, 404);
  assert.equal((await api(`/api/orders/${id}?t=errado`)).status, 404);
  let s = await (await api(`/api/orders/${id}?t=${c.accessToken}`)).json();
  assert.equal(s.order.status, 'awaiting_payment');
  const order = await store.getOrder(id);
  await fetch(`${mock.url}/__pay/${order.adex.transactionId}?webhook=0`);
  order.adex.lastCheckedAt = null; // força nova consulta
  await store.saveOrder(order);
  s = await (await api(`/api/orders/${id}?t=${c.accessToken}`)).json();
  assert.equal(s.order.status, 'paid');
  assert.equal(s.order.pix, undefined);
  assert.ok(s.order.offer.image.endsWith('.png'));
});

test('Webhook assinado confirma pagamento (validando na API)', async () => {
  const c = await (await api('/api/orders', { method: 'POST', body: validOrder() })).json();
  const order = await store.getOrder(c.order.id);
  await fetch(`${mock.url}/__pay/${order.adex.transactionId}`); // mock dispara o webhook assinado
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await store.getOrder(c.order.id)).status, 'paid');
});

test('Webhook: assinatura inválida = 401; evento de pedido desconhecido é ignorado', async () => {
  const payload = { event: 'charge.paid', data: { transaction_id: 'x' } };
  let r = await api('/api/webhooks/adex', { method: 'POST', body: payload, headers: { 'x-webhook-signature': 'sha256=' + 'a'.repeat(64) } });
  assert.equal(r.status, 401);
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', 'sk_test_x').update(raw).digest('hex');
  r = await api('/api/webhooks/adex', { method: 'POST', body: payload, headers: { 'x-webhook-signature': `sha256=${sig}` } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ignored, 'order_not_found');
});

test('Webhook "paid" forjado NÃO libera pedido se a API diz pendente', async () => {
  const c = await (await api('/api/orders', { method: 'POST', body: validOrder() })).json();
  const order = await store.getOrder(c.order.id);
  const payload = { event: 'charge.paid', data: { transaction_id: order.adex.transactionId, amount: 9700 } };
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', 'sk_test_x').update(raw).digest('hex');
  const r = await api('/api/webhooks/adex', { method: 'POST', body: payload, headers: { 'x-webhook-signature': `sha256=${sig}` } });
  assert.equal(r.status, 200);
  assert.equal((await store.getOrder(c.order.id)).status, 'awaiting_payment');
});

test('Lead (carrinho abandonado) e admin', async () => {
  let r = await api('/api/leads', { method: 'POST', body: { slug: 'ecovolt-3', name: 'João Pedro', email: 'j@x.com', phone: '11988887777', tracking: { utm_source: 'fb' } } });
  assert.equal(r.status, 200);
  const { leadId } = await r.json();
  assert.ok(leadId);
  assert.equal((await api('/api/admin/orders')).status, 401);
  assert.equal((await api('/api/admin/orders', { headers: { Authorization: 'Bearer errado' } })).status, 401);
  const ok = await api('/api/admin/leads', { headers: { Authorization: 'Bearer admin-secret-123' } });
  assert.equal((await ok.json()).count, 1);
  const csv = await api('/api/admin/orders.csv?status=paid', { headers: { Authorization: 'Bearer admin-secret-123' } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.ok(text.includes('Maria da Silva'));
});

test('Página do checkout e arquivos estáticos', async () => {
  const p = await fetch(`${base}/c/ecovolt-2-bk`);
  assert.equal(p.status, 200);
  assert.match(await p.text(), /<title>/);
  assert.equal((await fetch(`${base}/img/ecovolt-02.png`)).status, 200);
  assert.match((await fetch(`${base}/health`)).headers.get('content-security-policy'), /default-src 'self'/);
});

test('Trava de unidade: Adex em centavos com config em reais => PIX recusado e cancelado', async () => {
  await shutdown();
  await boot({ unit: 'centavos' }); // mock interpreta 97 como R$0,97
  const r = await api('/api/orders', { method: 'POST', body: validOrder() });
  assert.equal(r.status, 502);
  await new Promise((x) => setTimeout(x, 50));
  assert.ok(mock.calls.some((c) => c.path.endsWith('/cancel')), 'deve cancelar a cobrança divergente');
  assert.equal((await store.listOrders())[0].status, 'failed');
});

test('Sem chaves: 503 amigável', async () => {
  await shutdown();
  await boot({}, { ADEX_PUBLIC_KEY: '', ADEX_SECRET_KEY: '' });
  const r = await api('/api/orders', { method: 'POST', body: validOrder() });
  assert.equal(r.status, 503);
});

test('Leitor de valor do PIX (BR Code tag 54)', () => {
  assert.equal(pixAmountCents('00020126330014br.gov.bcb.pix0111abcdefghijk5204000053039865406115.526304ABCD'), 11552);
  assert.equal(pixAmountCents('000201520400005303986540597.005802BR6304ABCD'), 9700);
  assert.equal(pixAmountCents('00020152040000530398658 02BR6304ABCD'.replace(' ', '')), null);
  assert.equal(pixAmountCents(''), null);
  assert.equal(pixAmountCents('lixo'), null);
});
