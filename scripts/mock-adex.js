// Simulador da API da Adex (formato da doc https://adex.cash/docs). Serve para testes e para
// ver o checkout funcionando localmente sem chaves reais:
//   npm run mock:adex   (porta 4010)  +  ADEX_BASE_URL=http://localhost:4010 ADEX_PUBLIC_KEY=pk_test_x ADEX_SECRET_KEY=sk_test_x npm start
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const tlv = (tag, val) => `${tag}${String(val.length).padStart(2, '0')}${val}`;
// BR Code de teste com valor fixo (tag 54), igual ao formato real do PIX dinâmico.
const brcode = (id, cents) =>
  '000201' + tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('25', `mock.adex/${id}`)) + tlv('52', '0000') + tlv('53', '986') +
  tlv('54', (cents / 100).toFixed(2)) + tlv('58', 'BR') + tlv('59', 'ECOVOLT') + tlv('60', 'SAO PAULO') + tlv('62', tlv('05', '***')) + '6304ABCD';

export function startMockAdex({ port = 0, publicKey = 'pk_test_x', secretKey = 'sk_test_x', unit = 'reais', webhookSecret = secretKey } = {}) {
  const txs = new Map();
  const calls = [];

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => resolve(d ? JSON.parse(d) : null));
    });

  async function notify(tx, event) {
    if (!tx.postbackUrl) return;
    const payload = { event, data: { transaction_id: tx.id, external_id: tx.externalId, amount: tx.amountCents, status: tx.status, payment_method: 'pix' }, timestamp: new Date().toISOString() };
    const raw = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
    await fetch(tx.postbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-signature': `sha256=${sig}` }, body: raw }).catch(() => {});
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? await readBody(req) : null;
    calls.push({ method: req.method, path: url.pathname, body, headers: req.headers });

    // controles de teste (sem autenticação)
    if (url.pathname.startsWith('/__pay/')) {
      const tx = txs.get(url.pathname.split('/')[2]);
      if (!tx) return send(res, 404, { error: 'no tx' });
      tx.status = 'paid';
      tx.paidAt = new Date().toISOString();
      if (url.searchParams.get('webhook') !== '0') await notify(tx, 'charge.paid');
      return send(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/__expire/')) {
      const tx = txs.get(url.pathname.split('/')[2]);
      if (tx) tx.status = 'expired';
      return send(res, 200, { ok: true });
    }

    if (req.headers['x-public-key'] !== publicKey || req.headers['x-secret-key'] !== secretKey) {
      return send(res, 401, { error: { type: 'auth_error', message: 'Invalid API keys', code: 'INVALID_KEYS' } });
    }

    if (req.method === 'POST' && url.pathname === '/pix-receive') {
      if (!body?.amount || !body?.customer?.document?.number) {
        return send(res, 422, { error: { type: 'validation_error', message: 'Missing field', code: 'MISSING_REQUIRED_FIELD' } });
      }
      const id = crypto.randomUUID();
      const amountCents = unit === 'centavos' ? Math.round(body.amount) : Math.round(body.amount * 100);
      const tx = {
        id, externalId: body.external_id, status: 'pending', amountCents, postbackUrl: body.postbackUrl,
        expiration: body.pix?.expirationDate || new Date(Date.now() + 1800_000).toISOString(),
      };
      txs.set(id, tx);
      return send(res, 200, {
        id, shortId: id.slice(0, 9).toUpperCase(), status: 'pending', amount: body.amount, fee: 0, netAmount: body.amount, paymentMethod: 'pix',
        pix: { qrCode: brcode(id, amountCents), qrCodeUrl: `http://mock/qr/${id}`, expirationDate: tx.expiration },
        customer: { id: 'cust_1', name: body.customer.name, email: body.customer.email },
        createdAt: new Date().toISOString(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/pix-receive') {
      const tx = txs.get(url.searchParams.get('transaction_id'));
      if (!tx) return send(res, 404, { error: { message: 'not found' } });
      const value = unit === 'centavos' ? tx.amountCents : tx.amountCents / 100;
      return send(res, 200, { success: true, transaction: { id: tx.id, status: tx.status, amount: value, payment_method: 'pix', external_id: tx.externalId, paid_at: tx.paidAt || null } });
    }
    const cancel = url.pathname.match(/^\/transactions\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancel) {
      const tx = txs.get(cancel[1]);
      if (tx) tx.status = 'failed';
      return send(res, 200, { success: true });
    }
    send(res, 404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
  });

  return new Promise((resolve) =>
    server.listen(port, () => {
      const p = server.address().port;
      resolve({ url: `http://localhost:${p}`, port: p, txs, calls, close: () => new Promise((r) => server.close(r)) });
    })
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const m = await startMockAdex({ port: Number(process.env.MOCK_PORT) || 4010 });
  console.log(`[mock-adex] ${m.url}  (chaves: pk_test_x / sk_test_x)`);
  console.log(`Simular pagamento: curl ${m.url}/__pay/<transaction_id>`);
}
