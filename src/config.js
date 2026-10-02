// Toda a configuração vem de variáveis de ambiente (Railway -> Variables).
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|sim)$/i.test(String(v)));
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

export function loadConfig(e = process.env) {
  const port = int(e.PORT, 3000);
  const publicUrl = trimSlash(
    e.PUBLIC_URL || (e.RAILWAY_PUBLIC_DOMAIN ? `https://${e.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`)
  );
  return Object.freeze({
    env: e.NODE_ENV || 'development',
    isProd: e.NODE_ENV === 'production',
    port,
    publicUrl,
    trustProxy: int(e.TRUST_PROXY, 1),
    corsOrigin: e.CORS_ORIGIN ? e.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean) : [],
    databaseUrl: e.DATABASE_URL || '',
    adminToken: e.ADMIN_TOKEN || '',
    adex: Object.freeze({
      baseUrl: trimSlash(e.ADEX_BASE_URL || 'https://api.adex.cash/functions/v1'),
      publicKey: e.ADEX_PUBLIC_KEY || '',
      secretKey: e.ADEX_SECRET_KEY || '',
      webhookSecret: e.ADEX_WEBHOOK_SECRET || '',
      // A doc da Adex é ambígua: "reais" (exemplo) ou "centavos" (tabela). Validar com npm run smoke:adex.
      amountUnit: e.ADEX_AMOUNT_UNIT === 'centavos' ? 'centavos' : 'reais',
      timeoutMs: int(e.ADEX_TIMEOUT_MS, 20000),
    }),
    utmify: Object.freeze({
      token: e.UTMIFY_API_TOKEN || '',
      baseUrl: trimSlash(e.UTMIFY_BASE_URL || 'https://api.utmify.com.br'),
      platform: e.UTMIFY_PLATFORM || 'EcoVolt',
      // true = a Utmify valida o envio mas NÃO salva (use na primeira vez; depois remova)
      isTest: bool(e.UTMIFY_TEST, false),
    }),
    store: Object.freeze({
      name: e.STORE_NAME || 'EcoVolt',
      supportEmail: e.SUPPORT_EMAIL || 'contato@naturalli.shop',
      supportPhone: e.SUPPORT_PHONE || '+55 (11) 4004-2812',
      funnelUrl: trimSlash(e.FUNNEL_URL || ''),
    }),
    pixExpiresMinutes: int(e.PIX_EXPIRES_MINUTES, 30),
    requireWebhookSignature: bool(e.REQUIRE_WEBHOOK_SIGNATURE, false),
  });
}
