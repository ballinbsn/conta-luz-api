// Teste manual contra a Adex REAL, para confirmar a unidade do valor (reais x centavos) ANTES de vender.
// Uso (cria 1 cobrança PIX de R$ 5,00, que NÃO precisa ser paga):
//   ADEX_PUBLIC_KEY=pk_... ADEX_SECRET_KEY=sk_... npm run smoke:adex
// Recomendado usar chaves pk_test_/sk_test_. Depois confira no painel da Adex se a cobrança aparece como R$ 5,00.
import { loadConfig } from '../src/config.js';
import { AdexClient } from '../src/adex.js';
import { pixAmountCents } from '../src/lib/emv.js';

const config = loadConfig();
const adex = new AdexClient(config.adex);
if (!adex.configured) {
  console.error('Defina ADEX_PUBLIC_KEY e ADEX_SECRET_KEY.');
  process.exit(1);
}
const TOTAL = 500;
console.log(`Unidade configurada: ${adex.amountUnit}  |  enviando amount=${adex.toWire(TOTAL)} para ${config.adex.baseUrl}`);
try {
  const tx = await adex.createPix({
    totalCents: TOTAL,
    customer: { name: 'Teste Smoke', email: 'smoke@teste.com', phone: '11999999999', cpf: '52998224725' },
    address: { zip: '01310100', street: 'Av. Paulista', number: '1000', complement: '', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP' },
    items: [{ title: 'Teste de integração', cents: TOTAL, tangible: true }],
    externalId: `smoke-${Date.now()}`,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const inCode = pixAmountCents(tx.qrCode);
  console.log('transaction id :', tx.transactionId);
  console.log('status         :', tx.status);
  console.log('valor (API)    :', tx.amountCents, 'centavos');
  console.log('valor (no PIX) :', inCode == null ? 'sem valor fixo no código' : `${inCode} centavos  <- o que o cliente pagaria`);
  if (inCode != null && inCode !== TOTAL) {
    console.error(`\n❌ DIVERGÊNCIA: esperado ${TOTAL}, o PIX tem ${inCode}. Troque ADEX_AMOUNT_UNIT (reais <-> centavos) e rode de novo.`);
    process.exitCode = 2;
  } else {
    console.log('\n✅ Valor correto. Pode usar essa configuração.');
  }
  await adex.cancel(tx.transactionId).then(() => console.log('cobrança de teste cancelada.')).catch((e) => console.log('não foi possível cancelar (ok):', e.message));
} catch (e) {
  console.error('Falhou:', e.message, e.status || '', JSON.stringify(e.body || {}));
  process.exitCode = 1;
}
