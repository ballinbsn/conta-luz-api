// Cliente da API da Adex (https://adex.cash/docs). Base: https://api.adex.cash/functions/v1
// Autenticação: headers x-public-key + x-secret-key (a secret NUNCA vai para o navegador).
import { HttpError } from './lib/errors.js';

export class AdexError extends Error {
  constructor(message, { status = 0, body = null, code = 'adex_error' } = {}) {
    super(message);
    this.name = 'AdexError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

export class AdexClient {
  constructor({ baseUrl, publicKey, secretKey, amountUnit = 'reais', timeoutMs = 20000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.publicKey = publicKey;
    this.secretKey = secretKey;
    this.amountUnit = amountUnit;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  get configured() {
    return Boolean(this.publicKey && this.secretKey);
  }

  // centavos (interno) -> unidade que a Adex espera
  toWire(cents) {
    return this.amountUnit === 'centavos' ? Math.round(cents) : Math.round(cents) / 100;
  }
  // unidade da Adex -> centavos (interno)
  fromWire(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return this.amountUnit === 'centavos' ? Math.round(n) : Math.round(n * 100);
  }

  async #request(method, path, body) {
    if (!this.configured) throw new AdexError('Chaves da Adex não configuradas.', { code: 'not_configured' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'x-public-key': this.publicKey,
          'x-secret-key': this.secretKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new AdexError(err.name === 'AbortError' ? 'A Adex demorou para responder.' : 'Falha de rede com a Adex.', {
        code: err.name === 'AbortError' ? 'timeout' : 'network',
      });
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || `Adex respondeu ${res.status}`;
      throw new AdexError(msg, { status: res.status, body: data, code: data?.error?.code || 'http_' + res.status });
    }
    return data;
  }

  /**
   * Cria cobrança PIX.
   * @param {{totalCents:number, customer:object, address:object, items:{title:string,cents:number,tangible:boolean}[],
   *          postbackUrl?:string, externalId:string, expiresAt?:Date}} p
   */
  async createPix(p) {
    const sum = p.items.reduce((s, i) => s + i.cents, 0);
    if (sum !== p.totalCents) throw new AdexError('Itens não batem com o total.', { code: 'items_mismatch' });
    const body = {
      amount: this.toWire(p.totalCents),
      paymentMethod: 'pix',
      external_id: p.externalId,
      customer: {
        name: p.customer.name,
        email: p.customer.email,
        phone: p.customer.phone,
        document: { number: p.customer.cpf, type: 'cpf' },
        address: {
          zip: p.address.zip,
          street: p.address.street,
          number: p.address.number,
          complement: p.address.complement || '',
          neighborhood: p.address.neighborhood,
          city: p.address.city,
          state: p.address.state,
        },
      },
      items: p.items.map((i) => ({ title: i.title, unitPrice: this.toWire(i.cents), quantity: 1, tangible: i.tangible })),
      ...(p.postbackUrl ? { postbackUrl: p.postbackUrl } : {}),
      ...(p.expiresAt ? { pix: { expirationDate: p.expiresAt.toISOString() } } : {}),
    };
    const r = await this.#request('POST', '/pix-receive', body);
    const tx = r?.transaction ?? r;
    const transactionId = tx?.id || tx?.transaction_id || r?.transaction_id;
    const qrCode = tx?.pix?.qrCode || r?.pix?.qrCode;
    if (!transactionId || !qrCode) {
      throw new AdexError('Resposta da Adex sem id ou QR Code.', { body: r, code: 'bad_response' });
    }
    const amountCents = this.fromWire(tx?.amount ?? r?.amount);
    return {
      transactionId,
      shortId: tx?.shortId || r?.shortId || null,
      status: normalizeStatus(tx?.status || r?.status),
      amountCents,
      qrCode,
      qrCodeUrl: tx?.pix?.qrCodeUrl || r?.pix?.qrCodeUrl || null,
      expiresAt: tx?.pix?.expirationDate || r?.pix?.expirationDate || null,
      raw: r,
    };
  }

  /** Consulta status (fallback/validação do webhook). */
  async getTransaction(transactionId) {
    const r = await this.#request('GET', `/pix-receive?transaction_id=${encodeURIComponent(transactionId)}`);
    const t = r?.transaction ?? r;
    return {
      transactionId: t?.id || transactionId,
      status: normalizeStatus(t?.status),
      amountCents: this.fromWire(t?.amount),
      paidAt: t?.paid_at || null,
      raw: r,
    };
  }

  async cancel(transactionId) {
    return this.#request('POST', `/transactions/${encodeURIComponent(transactionId)}/cancel`, {});
  }
}

export function normalizeStatus(s) {
  const v = String(s || '').toLowerCase();
  if (['paid', 'approved', 'completed', 'confirmed'].includes(v)) return 'paid';
  if (['failed', 'refused', 'declined', 'canceled', 'cancelled'].includes(v)) return 'failed';
  if (v === 'expired') return 'expired';
  if (['refunded', 'chargeback'].includes(v)) return 'refunded';
  return 'pending';
}

export function adexUnavailable() {
  return new HttpError(503, 'payments_unavailable', 'Pagamento temporariamente indisponível. Tente novamente em instantes.');
}
