import test from 'node:test';
import assert from 'node:assert/strict';
import { isCpf, isPhoneBR, validateAddress, sanitizeTracking } from '../src/lib/validate.js';
import { getOffer, getShipping, computeTotals, normalizeSlug } from '../src/catalog.js';
import { AdexClient, normalizeStatus } from '../src/adex.js';

test('CPF: aceita válido, recusa inválido e repetido', () => {
  assert.equal(isCpf('529.982.247-25'), true);
  assert.equal(isCpf('52998224725'), true);
  assert.equal(isCpf('52998224724'), false);
  assert.equal(isCpf('11111111111'), false);
  assert.equal(isCpf('123'), false);
});

test('Celular BR', () => {
  assert.equal(isPhoneBR('(11) 99999-9999'), true);
  assert.equal(isPhoneBR('+55 11 99999-9999'), true);
  assert.equal(isPhoneBR('11 3333-4444'), true);
  assert.equal(isPhoneBR('11 89999-9999'), false);
  assert.equal(isPhoneBR('999'), false);
});

test('Endereço: exige campos e normaliza', () => {
  const a = validateAddress({ cep: '01310-100', street: 'Av. Paulista', number: '1000', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'sp' });
  assert.equal(a.zip, '01310100');
  assert.equal(a.state, 'SP');
  assert.throws(() => validateAddress({ cep: '123' }), (e) => e.field === 'cep');
});

test('Rastreamento: só chaves permitidas', () => {
  const t = sanitizeTracking({ utm_source: 'fb', evil: 'x', fbclid: 'abc' });
  assert.deepEqual(t, { utm_source: 'fb', fbclid: 'abc' });
});

test('Catálogo: preços e frete do servidor', () => {
  assert.equal(normalizeSlug('ECOVOLT-2-bk'), 'ecovolt-2');
  const o = getOffer('ecovolt-2-bk');
  assert.equal(o.priceCents, 9700);
  assert.deepEqual(computeTotals(o, getShipping('gratis')), { subtotalCents: 9700, shippingCents: 0, totalCents: 9700 });
  assert.equal(computeTotals(o, getShipping('sedex')).totalCents, 9700 + 1852);
  assert.equal(computeTotals(o, getShipping('correios')).totalCents, 9700 + 1450);
  assert.equal(getOffer('nao-existe'), null);
});

test('Adex: conversão de unidade', () => {
  const r = new AdexClient({ baseUrl: 'x', publicKey: 'a', secretKey: 'b', amountUnit: 'reais' });
  assert.equal(r.toWire(9700), 97);
  assert.equal(r.fromWire(97), 9700);
  assert.equal(r.fromWire(18.52), 1852);
  const c = new AdexClient({ baseUrl: 'x', publicKey: 'a', secretKey: 'b', amountUnit: 'centavos' });
  assert.equal(c.toWire(9700), 9700);
  assert.equal(c.fromWire(9700), 9700);
});

test('Adex: status normalizados', () => {
  assert.equal(normalizeStatus('PAID'), 'paid');
  assert.equal(normalizeStatus('approved'), 'paid');
  assert.equal(normalizeStatus('expired'), 'expired');
  assert.equal(normalizeStatus('refunded'), 'refunded');
  assert.equal(normalizeStatus('qualquer'), 'pending');
});
