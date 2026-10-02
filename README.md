# conta-luz-api

Checkout EcoVolt + API de vendas integrada à **Adex** (PIX). Serviço único em Node.js, pronto para o **Railway**.

```
Funil (advertorial → VSL → ofertas)  ──botão COMPRAR──►  /c/ecovolt-{1|2|3}  (checkout, 3 etapas)
                                                              │  POST /api/orders
                                                              ▼
                                              API (preços e frete SEMPRE no servidor)
                                                              │  POST {ADEX}/pix-receive
                                                              ▼
                              Adex ──webhook charge.paid──► POST /api/webhooks/adex  (confirma na API e marca "paid")
```

## O que já vem pronto

- **Checkout** em 3 etapas (Identificação → Entrega → Pagamento PIX), mobile first, CEP automático, frete igual ao checkout de referência (Grátis 7–12 dias, Sedex R$ 18,52 em 5 dias, Correios R$ 14,50 em 4–7 dias), brinde *Garantia Vitalícia*, depoimentos, cronômetro de reserva.
- **Tela do PIX**: QR Code, "copia e cola", cronômetro de expiração e confirmação automática.
- **Tela de sucesso** com a **imagem do produto**, brinde, prazo estimado e endereço.
- **API Adex**: `pix-receive` (criar e consultar), `transactions/:id/cancel`, webhook com validação HMAC-SHA256.
- **Segurança**: preços só no servidor, secret da Adex só no servidor, rate limit, CSP, idempotência (duplo clique não cobra duas vezes), webhook de "pago" é **sempre confirmado na API da Adex** antes de liberar o pedido, trava que recusa PIX com valor diferente do pedido.
- **Carrinho abandonado**: o lead é salvo ao fim da etapa 1 (`GET /api/admin/leads`).
- **Pedidos**: Postgres + painel por API e CSV para despacho (`/api/admin/orders.csv`).

## Rotas

| Rota | Descrição |
|---|---|
| `GET /c/:slug` | Checkout (`ecovolt-1`, `ecovolt-2`, `ecovolt-3`; sufixo `-bk` também funciona) |
| `GET /pedido/:id?t=TOKEN` | Tela do PIX / sucesso (link seguro por pedido) |
| `GET /api/offers/:slug` | Oferta, frete, brinde |
| `GET /api/cep/:cep` | Busca de CEP (proxy do ViaCEP) |
| `POST /api/leads` | Salva lead (etapa 1) |
| `POST /api/orders` | Cria pedido + PIX |
| `GET /api/orders/:id?t=TOKEN` | Status (consulta a Adex se estiver pendente) |
| `POST /api/webhooks/adex` | Webhook da Adex |
| `GET /api/admin/orders[?status=paid]` · `/api/admin/orders.csv` · `/api/admin/leads` | Painel (header `Authorization: Bearer ADMIN_TOKEN`) |
| `GET /health` | Saúde (usado pelo Railway) |

## Rodar localmente (sem chaves, com simulador da Adex)

```bash
npm install
npm run mock:adex          # terminal 1 — simulador em http://localhost:4010
ADEX_BASE_URL=http://localhost:4010 ADEX_PUBLIC_KEY=pk_test_x ADEX_SECRET_KEY=sk_test_x npm start   # terminal 2
# abra http://localhost:3000/c/ecovolt-2 — para "pagar": curl http://localhost:4010/__pay/<transaction_id>
npm test                   # 21 testes
```

## Colocar no ar (Railway)

1. **New Project → Deploy from GitHub repo →** `ballinbsn/conta-luz-api`.
2. **+ New → Database → PostgreSQL**. No serviço da API: *Variables → Add Reference →* `DATABASE_URL`.
3. Em *Variables* cadastre (veja `.env.example`): `ADEX_PUBLIC_KEY`, `ADEX_SECRET_KEY`, `ADMIN_TOKEN`, `FUNNEL_URL`, `NODE_ENV=production`.
4. *Settings → Networking → Generate Domain* (ou domínio próprio). Se usar domínio próprio, defina `PUBLIC_URL`.
5. **Confirme a unidade do valor** (a doc da Adex é ambígua entre reais e centavos), com chaves de teste:
   `ADEX_PUBLIC_KEY=pk_test_… ADEX_SECRET_KEY=sk_test_… npm run smoke:adex`
   Deve imprimir ✅. Se imprimir ❌, defina `ADEX_AMOUNT_UNIT=centavos`.
6. **Webhook:** o `postbackUrl` já é enviado em cada cobrança (`{domínio}/api/webhooks/adex`). Se quiser também no painel da Adex: *Dashboard → Webhooks →* essa mesma URL, eventos `charge.paid`, `charge.failed`, `charge.refunded`.
7. No funil, em `oferta/index.html`, ajuste `CHECKOUT_BASE` para o domínio do Railway.
8. Faça **uma compra real de teste** (kit de 1 unidade) e confira: PIX gerado → pago → tela de sucesso → pedido `paid` em `/api/admin/orders`.

## Pendências conhecidas

- **Cartão de crédito:** a doc da Adex exige tokenizar o cartão no navegador com `PayGateway.createToken(...)`, mas **não publica a URL dessa biblioteca**. Peça o script ao suporte da Adex; com ele o cartão entra em ~1 hora de trabalho. Até lá o checkout é só PIX (maior conversão no Brasil de qualquer forma).
- **Utmify:** pixel + script de UTMs instalados (`public/utmify.js`, mesmo ID do funil). Cada venda é enviada à API da Utmify (`waiting_payment` ao gerar o PIX, depois `paid`/`refunded`/`refused`) quando `UTMIFY_API_TOKEN` está definido. Primeiro envio: use `UTMIFY_TEST=true` (valida sem salvar), confira nos logs e remova a variável.
- **Meta CAPI:** não incluída. UTMs/`fbclid` ficam salvos em cada pedido (`tracking`), prontos para a Conversions API.
- `external_id` no `pix-receive` não aparece na doc de criação (só na consulta); é enviado e ignorado se não suportado. O vínculo principal é pelo `transaction_id`.
