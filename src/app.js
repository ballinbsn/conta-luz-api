import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createOrderService } from './orders.js';
import { getOffer, SHIPPING, DEFAULT_SHIPPING_ID, BONUS, PROOFS } from './catalog.js';
import { HttpError } from './lib/errors.js';
import { onlyDigits } from './lib/validate.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const limiter = (limit, windowMs = 60_000) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'rate_limited', message: 'Muitas tentativas. Aguarde um instante e tente de novo.' } }),
  });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita injeção de fórmula no Excel
  return `"${s.replace(/"/g, '""')}"`;
};

export function createApp({ config, store, adex, utmify = null, log = console }) {
  const app = express();
  const orders = createOrderService({ config, store, adex, utmify, log });
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://*.utmify.com.br'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https://*.utmify.com.br'],
          connectSrc: ["'self'", 'https://*.utmify.com.br', 'https://api.ipify.org', 'https://api6.ipify.org'],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })
  );
  app.use(compression());
  if (config.corsOrigin.length) app.use('/api', cors({ origin: config.corsOrigin }));

  // ---- Webhook (corpo bruto para validar a assinatura HMAC) ----
  app.post(
    '/api/webhooks/adex',
    limiter(300),
    express.json({ limit: '100kb', verify: (req, _res, buf) => (req.rawBody = buf.toString('utf8')) }),
    wrap(async (req, res) => {
      const out = await orders.handleWebhook({ raw: req.rawBody, body: req.body, signature: req.get('x-webhook-signature') });
      res.json(out);
    })
  );

  app.use(express.json({ limit: '20kb' }));

  // ---- Saúde ----
  app.get(
    '/health',
    wrap(async (_req, res) => {
      let db = false;
      try {
        db = await store.ping();
      } catch {}
      res.status(db ? 200 : 503).json({ ok: db, store: store.kind, adexConfigured: adex.configured, time: new Date().toISOString() });
    })
  );

  // ---- Oferta (preços vêm do servidor) ----
  app.get('/api/offers/:slug', limiter(600), (req, res) => {
    const offer = getOffer(req.params.slug);
    if (!offer) throw new HttpError(404, 'offer_not_found', 'Oferta não encontrada.');
    res.set('Cache-Control', 'no-store');
    res.json({
      offer,
      shipping: SHIPPING,
      defaultShippingId: DEFAULT_SHIPPING_ID,
      bonus: BONUS,
      proofs: PROOFS,
      store: { name: config.store.name, supportEmail: config.store.supportEmail, supportPhone: config.store.supportPhone, funnelUrl: config.store.funnelUrl },
      paymentsReady: adex.configured,
    });
  });

  // ---- CEP (proxy do ViaCEP: o navegador só fala com este servidor) ----
  const cepCache = new Map();
  app.get(
    '/api/cep/:cep',
    limiter(300),
    wrap(async (req, res) => {
      const cep = onlyDigits(req.params.cep);
      if (cep.length !== 8) throw new HttpError(422, 'validation_error', 'CEP inválido.', 'cep');
      const hit = cepCache.get(cep);
      if (hit && hit.exp > Date.now()) return res.json(hit.data);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: ctrl.signal });
        const j = await r.json();
        if (j.erro) throw new HttpError(404, 'cep_not_found', 'CEP não encontrado.', 'cep');
        const data = { cep, street: j.logradouro || '', neighborhood: j.bairro || '', city: j.localidade || '', state: j.uf || '' };
        cepCache.set(cep, { data, exp: Date.now() + 86_400_000 });
        if (cepCache.size > 2000) cepCache.clear();
        res.json(data);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, 'cep_unavailable', 'Não foi possível buscar o CEP. Preencha o endereço manualmente.');
      } finally {
        clearTimeout(timer);
      }
    })
  );

  // ---- Lead (carrinho abandonado: salvo ao concluir a etapa 1) ----
  app.post(
    '/api/leads',
    limiter(120),
    wrap(async (req, res) => {
      const out = await orders.saveLead({ ...(req.body || {}), ...(req.body?.customer || {}) }, { ip: req.ip });
      res.json(out);
    })
  );

  // ---- Pedido ----
  app.post(
    '/api/orders',
    limiter(60),
    wrap(async (req, res) => {
      const { view, order } = await orders.createOrder(req.body || {}, { ip: req.ip, userAgent: req.get('user-agent') });
      res.status(201).json({ order: view, accessToken: order.accessToken });
    })
  );

  app.get(
    '/api/orders/:id',
    limiter(1200),
    wrap(async (req, res) => {
      const { view } = await orders.getForClient(req.params.id, String(req.query.t || ''));
      res.set('Cache-Control', 'no-store');
      res.json({ order: view });
    })
  );

  // ---- Admin (Bearer ADMIN_TOKEN) ----
  const admin = (req, _res, next) => {
    const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const ok = config.adminToken && given.length === config.adminToken.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(config.adminToken));
    if (!ok) return next(new HttpError(401, 'unauthorized', 'Não autorizado.'));
    next();
  };
  const strip = (o) => ({ ...o, accessToken: undefined });

  app.get(
    '/api/admin/orders',
    limiter(60),
    admin,
    wrap(async (req, res) => {
      const list = await store.listOrders({ status: req.query.status ? String(req.query.status) : undefined, limit: Math.min(Number(req.query.limit) || 200, 1000) });
      res.set('Cache-Control', 'no-store').json({ count: list.length, orders: list.map(strip) });
    })
  );

  app.get(
    '/api/admin/orders.csv',
    limiter(30),
    admin,
    wrap(async (req, res) => {
      const list = await store.listOrders({ status: req.query.status ? String(req.query.status) : 'paid', limit: 1000 });
      const head = ['pedido', 'criado_em', 'pago_em', 'status', 'oferta', 'qtd', 'subtotal', 'frete_nome', 'frete_valor', 'total', 'nome', 'email', 'telefone', 'cpf', 'cep', 'rua', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'utm_source', 'utm_campaign', 'utm_content', 'adex_id'];
      const rows = list.map((o) =>
        [o.id, o.createdAt, o.paidAt, o.status, o.offer.name, o.offer.qty, (o.totals.subtotalCents / 100).toFixed(2), o.shipping.name, (o.totals.shippingCents / 100).toFixed(2), (o.totals.totalCents / 100).toFixed(2), o.customer.name, o.customer.email, o.customer.phone, o.customer.cpf, o.address.zip, o.address.street, o.address.number, o.address.complement, o.address.neighborhood, o.address.city, o.address.state, o.tracking?.utm_source, o.tracking?.utm_campaign, o.tracking?.utm_content, o.adex?.transactionId].map(csvCell).join(',')
      );
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="pedidos.csv"', 'Cache-Control': 'no-store' });
      res.send('﻿' + [head.join(','), ...rows].join('\n'));
    })
  );

  app.get(
    '/api/admin/leads',
    limiter(30),
    admin,
    wrap(async (_req, res) => {
      const leads = await store.listLeads({ limit: 500 });
      res.set('Cache-Control', 'no-store').json({ count: leads.length, leads });
    })
  );

  // ---- Páginas ----
  const sendCheckout = (_req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(PUBLIC_DIR, 'checkout.html'));
  app.get('/c/:slug', sendCheckout);
  app.get('/pedido/:id', sendCheckout);
  app.get('/', (_req, res) => {
    if (config.store.funnelUrl) return res.redirect(302, config.store.funnelUrl);
    res.json({ ok: true, service: 'conta-luz-api' });
  });
  // imagens: cache longo; html/js/css: sempre revalidam (ETag), para deploys novos valerem na hora
  app.use(express.static(PUBLIC_DIR, { index: false, setHeaders: (res, p) => res.setHeader('Cache-Control', /.(png|jpe?g|webp|ico|svg)$/i.test(p) ? 'public, max-age=604800' : 'no-cache') }));

  // ---- Erros ----
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'Rota não encontrada.')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) } });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Requisição inválida.' } });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Requisição grande demais.' } });
    log.error('[erro]', err);
    res.status(500).json({ error: { code: 'internal', message: 'Erro interno. Tente novamente.' } });
  });

  return app;
}
