// Envio de vendas para a Utmify (https://docs.utmify.com.br/send-orders).
// POST {baseUrl}/api-credentials/orders  com header x-api-token.
// Eventos: waiting_payment (PIX gerado), paid, refunded, refused. O token vem de UTMIFY_API_TOKEN (Railway).

const pad = (n) => String(n).padStart(2, '0');
export function utcStamp(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// status interno do pedido -> status da Utmify (expired/creating/payment_review não são enviados)
export const STATUS_MAP = { awaiting_payment: 'waiting_payment', paid: 'paid', refunded: 'refunded', failed: 'refused' };

const isPublicIp = (ip) => Boolean(ip) && !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(String(ip));

export function buildPayload(order, status, { platform = 'EcoVolt', isTest = false } = {}) {
  const t = order.tracking || {};
  const products = [
    { id: order.slug, name: order.offer.name, planId: null, planName: null, quantity: 1, priceInCents: order.totals.subtotalCents },
  ];
  if (order.totals.shippingCents > 0) {
    products.push({ id: `frete-${order.shipping.id}`, name: order.shipping.name, planId: null, planName: null, quantity: 1, priceInCents: order.totals.shippingCents });
  }
  const total = order.totals.totalCents;
  const fee = Math.min(Math.max(order.adex?.feeCents || 0, 0), total - 1);
  const refundedEvent = [...(order.events || [])].reverse().find((e) => e.type === 'status:refunded');
  return {
    orderId: order.id,
    platform,
    paymentMethod: 'pix',
    status,
    createdAt: utcStamp(order.createdAt),
    approvedDate: order.paidAt ? utcStamp(order.paidAt) : null,
    refundedAt: status === 'refunded' ? utcStamp(refundedEvent?.at || new Date()) : null,
    customer: {
      name: order.customer.name,
      email: order.customer.email,
      phone: order.customer.phone || null,
      document: order.customer.cpf || null,
      country: 'BR',
      ...(isPublicIp(order.ip) ? { ip: order.ip } : {}),
    },
    products,
    trackingParameters: {
      src: t.src ?? null,
      sck: t.sck ?? null,
      utm_source: t.utm_source ?? null,
      utm_campaign: t.utm_campaign ?? null,
      utm_medium: t.utm_medium ?? null,
      utm_content: t.utm_content ?? null,
      utm_term: t.utm_term ?? null,
    },
    commission: { totalPriceInCents: total, gatewayFeeInCents: fee, userCommissionInCents: total - fee },
    isTest,
  };
}

export class UtmifyClient {
  constructor({ token = '', baseUrl = 'https://api.utmify.com.br', platform = 'EcoVolt', isTest = false, fetchImpl = fetch, retryDelaysMs = [1000, 4000, 15000], timeoutMs = 10000 } = {}) {
    Object.assign(this, { token, baseUrl: String(baseUrl).replace(/\/+$/, ''), platform, isTest, fetch: fetchImpl, retryDelaysMs, timeoutMs });
  }
  get enabled() {
    return Boolean(this.token);
  }

  async #post(payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}/api-credentials/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-token': this.token },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        const err = new Error(`Utmify respondeu ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Envia com novas tentativas em falha de rede/5xx/429. Erros 4xx (payload/token inválido) não repetem. */
  async sendOrder(order, status) {
    const payload = buildPayload(order, status, { platform: this.platform, isTest: this.isTest });
    let lastErr;
    for (let i = 0; i <= this.retryDelaysMs.length; i++) {
      try {
        return await this.#post(payload);
      } catch (err) {
        lastErr = err;
        const retryable = !err.status || err.status >= 500 || err.status === 429;
        if (!retryable || i === this.retryDelaysMs.length) break;
        await new Promise((r) => setTimeout(r, this.retryDelaysMs[i]));
      }
    }
    throw lastErr;
  }
}
