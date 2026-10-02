import { HttpError } from './errors.js';

export const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

export function isCpf(value) {
  const d = onlyDigits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

export const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;

export function normalizePhone(v) {
  const d = onlyDigits(v);
  return d.startsWith('55') && d.length > 11 ? d.slice(2) : d;
}
export function isPhoneBR(v) {
  const n = normalizePhone(v);
  if (n.length !== 10 && n.length !== 11) return false;
  if (n.length === 11 && n[2] !== '9') return false;
  return Number(n.slice(0, 2)) >= 11;
}

const fail = (field, message) => {
  throw new HttpError(422, 'validation_error', message, field);
};

export function validateIdentity(c = {}) {
  const name = str(c.name, 120).replace(/\s+/g, ' ');
  if (name.split(' ').filter((p) => p.length > 1).length < 2) fail('name', 'Informe seu nome completo.');
  const email = str(c.email, 254).toLowerCase();
  if (!isEmail(email)) fail('email', 'Informe um e-mail válido.');
  if (!isPhoneBR(c.phone)) fail('phone', 'Informe um celular válido com DDD.');
  return { name, email, phone: normalizePhone(c.phone) };
}

export function validateAddress(a = {}) {
  const zip = onlyDigits(a.cep ?? a.zip);
  if (zip.length !== 8) fail('cep', 'Informe um CEP válido.');
  const street = str(a.street, 160);
  if (street.length < 3) fail('street', 'Informe a rua.');
  const number = str(a.number, 20);
  if (!number) fail('number', 'Informe o número (ou S/N).');
  const neighborhood = str(a.neighborhood, 100);
  if (neighborhood.length < 2) fail('neighborhood', 'Informe o bairro.');
  const city = str(a.city, 100);
  if (city.length < 2) fail('city', 'Informe a cidade.');
  const state = str(a.state, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) fail('state', 'Informe o estado (UF).');
  return { zip, street, number, complement: str(a.complement, 80), neighborhood, city, state };
}

export function validateCpf(v) {
  if (!isCpf(v)) fail('cpf', 'CPF inválido. Confira os números.');
  return onlyDigits(v);
}

const TRACKING_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'ttclid', 'src', 'sck', 'xcod', 'campaign_id', 'adset_id', 'ad_id'];
export function sanitizeTracking(obj = {}) {
  const out = {};
  if (obj && typeof obj === 'object') {
    for (const k of TRACKING_KEYS) if (obj[k] != null && obj[k] !== '') out[k] = str(obj[k], 200);
  }
  return out;
}
