import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { getOffer, getShipping, computeTotals, DEFAULT_SHIPPING_ID } from './catalog.js';
import { adexUnavailable, AdexError } from './adex.js';
import { HttpError } from './lib/errors.js';
import { pixAmountCents } from './lib/emv.js';
import { STATUS_MAP } from './utmify.js';
import { validateIdentity, validateAddress, validateCpf, sanitizeTracking } from './lib/validate.js';

const FINAL = new Set(['paid', 'refunded']);
const POLL_MIN_INTERVAL_MS = 3000;

const nowIso = () => new Date().toISOString();
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function createOrderService({ config, store, adex, utmify = null, log = console }) {
  const note = (order, type, detail) => {
    (order.events ||= []).push({ at: nowIso(), type, ...(detail ? { detail } : {}) });
    if (order.events.length > 50) order.events.splice(0, order.events.length - 50);
  };

  // Avisa a Utmify (sem travar o cliente). Cada status é enviado uma única vez por pedido.
  async function notifyUtmify(order) {
    if (!utmify?.enabled) return;
    const st = STATUS_MAP[order.status];
    if (!st) return;
    order.utmify ||= {};
    if (order.utmify[st]) return;
    try {
      await utmify.sendOrder(order, st);
      order.utmify[st] = nowIso();
      note(order, `utmify:${st}`);
    } catch (err) {
      log.error('[utmify] envio falhou', { orderId: order.id, status: st, message: err.message });
      note(order, `utmify_failed:${st}`, err.message);
    }
    await store.saveOrder(order).catch(() => {});
  }

  async function toPublic(order, { withPix = true } = {}) {
    const pub = {
      id: order.id,
      status: order.status,
      slug: order.slug,
      offer: order.offer,
      shipping: order.shipping,
      totals: order.totals,
      customer: { name: order.customer.name, email: order.customer.email },
      address: {
        street: order.address.street,
        number: order.address.number,
        complement: order.address.complement,
        neighborhood: order.address.neighborhood,
        city: order.address.city,
        state: order.address.state,
        zip: order.address.zip,
      },
      createdAt: order.createdAt,
      paidAt: order.paidAt || null,
    };
    if (withPix && order.status === 'awaiting_payment' && order.adex?.qrCode) {
      pub.pix = {
        qrCode: order.adex.qrCode,
        qrImage: await QRCode.toDataURL(order.adex.qrCode, { margin: 1, width: 360, errorCorrectionLevel: 'M' }),
        expiresAt: order.adex.expiresAt,
      };
    }
    return pub;
  }

  async function createOrder(input, ctx = {}) {
    if (!adex.configured) throw adexUnavailable();

    const offer = getOffer(input.slug);
    if (!offer) throw new HttpError(404, 'offer_not_found', 'Oferta não encontrada.');
    const shipping = getShipping(input.shippingId || DEFAULT_SHIPPING_ID);
    if (!shipping) throw new HttpError(422, 'validation_error', 'Escolha uma forma de entrega.', 'shippingId');

    const identity = validateIdentity(input.customer);
    const cpf = validateCpf(input.customer?.cpf);
    const address = validateAddress(input.address);
    const tracking = sanitizeTracking(input.tracking);

    const key = typeof input.idempotencyKey === 'string' && /^[\w-]{8,64}$/.test(input.idempotencyKey) ? input.idempotencyKey : null;
    if (key) {
      const existing = await store.findOrderByKey(key);
      if (existing) {
        if (existing.status === 'awaiting_payment' || existing.status === 'paid') {
          return { order: existing, view: await toPublic(existing), reused: true };
        }
        throw new HttpError(409, 'retry', 'Não foi possível reutilizar essa tentativa. Tente novamente.');
      }
    }

    const totals = computeTotals(offer, shipping);
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + config.pixExpiresMinutes * 60_000);

    const order = {
      id,
      accessToken: crypto.randomBytes(24).toString('hex'),
      status: 'creating',
      slug: offer.slug,
      offer: { name: offer.name, qty: offer.qty, image: offer.image, priceCents: offer.priceCents, anchorCents: offer.anchorCents },
      shipping: { id: shipping.id, name: shipping.name, priceCents: shipping.priceCents, minDays: shipping.minDays, maxDays: shipping.maxDays },
      totals,
      customer: { ...identity, cpf },
      address,
      tracking,
      leadId: input.leadId || null,
      ip: ctx.ip || null,
      userAgent: ctx.userAgent ? String(ctx.userAgent).slice(0, 300) : null,
      idempotencyKey: key,
      adex: null,
      paidAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      events: [],
    };
    note(order, 'created');
    await store.insertOrder(order);

    const items = [{ title: offer.name, cents: offer.priceCents, tangible: true }];
    if (shipping.priceCents > 0) items.push({ title: shipping.name, cents: shipping.priceCents, tangible: false });

    let tx;
    try {
      tx = await adex.createPix({
        totalCents: totals.totalCents,
        customer: order.customer,
        address,
        items,
        externalId: order.id,
        postbackUrl: `${config.publicUrl}/api/webhooks/adex`,
        expiresAt,
      });
    } catch (err) {
      note(order, 'adex_create_failed', `${err.code || ''} ${err.status || ''} ${err.message}`.trim());
      order.status = 'failed';
      await store.saveOrder(order);
      log.error('[adex] pix-receive falhou', { orderId: order.id, status: err.status, code: err.code, message: err.message, body: err.body });
      if (err instanceof AdexError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw new HttpError(502, 'payment_rejected', 'Não foi possível gerar o PIX com esses dados. Confira o CPF e tente novamente.');
      }
      throw new HttpError(502, 'payment_unavailable', 'Não foi possível gerar o PIX agora. Tente novamente em instantes.');
    }

    // Trava contra erro de unidade (reais x centavos): nunca mostrar um PIX com valor diferente do pedido.
    // O valor dentro do próprio código PIX (tag 54) é a fonte mais confiável; o valor devolvido pela API é o 2º check.
    const inCode = pixAmountCents(tx.qrCode);
    if ((inCode != null && inCode !== totals.totalCents) || (tx.amountCents != null && tx.amountCents !== totals.totalCents)) {
      log.error('[adex] valor divergente', { orderId: order.id, esperado: totals.totalCents, api: tx.amountCents, noPix: inCode, unidade: adex.amountUnit });
      note(order, 'amount_mismatch', `esperado=${totals.totalCents} api=${tx.amountCents} pix=${inCode}`);
      order.status = 'failed';
      order.adex = { transactionId: tx.transactionId };
      await store.saveOrder(order);
      adex.cancel(tx.transactionId).catch((e) => log.error('[adex] cancel falhou', e.message));
      throw new HttpError(502, 'payment_unavailable', 'Não foi possível gerar o PIX agora. Tente novamente em instantes.');
    }

    order.adex = {
      transactionId: tx.transactionId,
      shortId: tx.shortId,
      qrCode: tx.qrCode,
      expiresAt: tx.expiresAt || expiresAt.toISOString(),
      feeCents: tx.feeCents ?? null,
      lastCheckedAt: null,
    };
    order.status = tx.status === 'paid' ? 'paid' : 'awaiting_payment';
    if (order.status === 'paid') order.paidAt = nowIso();
    note(order, 'pix_created', tx.transactionId);
    await store.saveOrder(order);

    notifyUtmify(order).catch(() => {});
    if (order.leadId) {
      store.getLead(order.leadId).then((l) => l && store.saveLead({ ...l, converted: true, orderId: order.id })).catch(() => {});
    }
    return { order, view: await toPublic(order), reused: false };
  }

  // Aplica um status vindo da Adex (polling ou webhook). Idempotente.
  async function applyStatus(order, adexStatus, meta = {}) {
    const prev = order.status;
    if (adexStatus === 'paid') {
      if (order.status === 'paid') return order;
      if (meta.amountCents != null && meta.amountCents < order.totals.totalCents) {
        order.status = 'payment_review';
        note(order, 'underpaid', `pago=${meta.amountCents} esperado=${order.totals.totalCents}`);
      } else {
        order.status = 'paid';
        order.paidAt = meta.paidAt || nowIso();
      }
    } else if (adexStatus === 'refunded') {
      if (order.status === 'paid' || order.status === 'payment_review') order.status = 'refunded';
    } else if (adexStatus === 'failed' || adexStatus === 'expired') {
      if (!FINAL.has(order.status) && order.status !== 'payment_review') order.status = adexStatus;
    }
    if (meta.feeCents != null && order.adex) order.adex.feeCents = meta.feeCents;
    if (order.status !== prev) {
      note(order, `status:${order.status}`, meta.source);
      await store.saveOrder(order);
      notifyUtmify(order).catch(() => {});
    }
    return order;
  }

  async function refresh(order) {
    if (order.status !== 'awaiting_payment' || !order.adex?.transactionId || !adex.configured) return order;
    const last = order.adex.lastCheckedAt ? Date.parse(order.adex.lastCheckedAt) : 0;
    if (Date.now() - last < POLL_MIN_INTERVAL_MS) return order;
    order.adex.lastCheckedAt = nowIso();
    try {
      const t = await adex.getTransaction(order.adex.transactionId);
      await applyStatus(order, t.status, { amountCents: t.amountCents, feeCents: t.feeCents, paidAt: t.paidAt, source: 'poll' });
    } catch (err) {
      log.warn('[adex] consulta de status falhou', { orderId: order.id, message: err.message });
    }
    await store.saveOrder(order);
    return order;
  }

  async function getForClient(id, token) {
    const order = await store.getOrder(id);
    if (!order || !token || !safeEqual(order.accessToken, token)) throw new HttpError(404, 'not_found', 'Pedido não encontrado.');
    await refresh(order);
    return { order, view: await toPublic(order) };
  }

  function signatureMatches(raw, parsed, header) {
    const sig = String(header || '').replace(/^sha256=/i, '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sig)) return false;
    const secrets = [config.adex.webhookSecret, config.adex.secretKey].filter(Boolean);
    const bodies = [raw, JSON.stringify(parsed)].filter((b) => b != null);
    for (const s of secrets) {
      for (const b of bodies) {
        const exp = crypto.createHmac('sha256', s).update(b).digest('hex');
        if (safeEqual(exp, sig)) return true;
      }
    }
    return false;
  }

  async function handleWebhook({ raw, body, signature }) {
    const hasSecret = Boolean(config.adex.webhookSecret || config.adex.secretKey);
    if (signature) {
      if (hasSecret && !signatureMatches(raw, body, signature)) throw new HttpError(401, 'invalid_signature', 'Assinatura inválida.');
    } else if (config.requireWebhookSignature) {
      throw new HttpError(401, 'missing_signature', 'Assinatura ausente.');
    }

    const event = String(body?.event || '');
    const data = body?.data || {};
    const txId = data.transaction_id || data.id || null;
    const externalId = data.external_id || null;

    let order = txId ? await store.findOrderByAdexId(txId) : null;
    if (!order && externalId) order = await store.getOrder(String(externalId));
    if (!order) {
      log.warn('[webhook] pedido não encontrado', { event, txId, externalId });
      return { ok: true, ignored: 'order_not_found' };
    }

    const map = { 'charge.paid': 'paid', 'charge.failed': 'failed', 'charge.refunded': 'refunded', 'charge.chargeback': 'refunded' };
    const target = map[event];
    if (!target) return { ok: true, ignored: 'event_not_handled' };

    if (target === 'paid') {
      // Nunca liberar pedido só pelo webhook: confirma na API (a doc recomenda). Se a API falhar, responde 502 e a Adex reenvia.
      if (!adex.configured) throw new HttpError(503, 'payments_unavailable', 'Chaves da Adex ausentes.');
      let t;
      try {
        t = await adex.getTransaction(order.adex?.transactionId || txId);
      } catch (err) {
        log.error('[webhook] não foi possível confirmar na API', err.message);
        throw new HttpError(502, 'verify_failed', 'Falha ao confirmar pagamento.');
      }
      await applyStatus(order, t.status, { amountCents: t.amountCents, feeCents: t.feeCents, paidAt: t.paidAt, source: 'webhook' });
    } else {
      await applyStatus(order, target, { source: 'webhook' });
    }
    await store.recordEvent(`${event}:${txId || order.id}`).catch(() => {});
    return { ok: true, status: order.status };
  }

  async function saveLead(input, ctx = {}) {
    const offer = getOffer(input.slug);
    if (!offer) throw new HttpError(404, 'offer_not_found', 'Oferta não encontrada.');
    const identity = validateIdentity(input);
    const id = typeof input.leadId === 'string' && /^[\w-]{8,64}$/.test(input.leadId) ? input.leadId : crypto.randomUUID();
    const prev = (await store.getLead(id)) || {};
    const lead = {
      ...prev,
      id,
      slug: offer.slug,
      ...identity,
      tracking: { ...(prev.tracking || {}), ...sanitizeTracking(input.tracking) },
      createdAt: prev.createdAt || nowIso(),
      converted: prev.converted || false,
      ip: ctx.ip || prev.ip || null,
    };
    await store.saveLead(lead);
    return { leadId: id };
  }

  return { createOrder, getForClient, handleWebhook, saveLead, applyStatus, refresh, toPublic };
}
