/* Checkout EcoVolt — 3 etapas (Identificação > Entrega > Pagamento PIX) */
(() => {
  'use strict';

  // ---------- utilidades ----------
  const $app = document.getElementById('app');
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v; // somente SVG/estático nosso
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  };
  const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const digits = (v) => String(v || '').replace(/\D/g, '');
  const ss = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  const ICON = {
    chev: '<svg class="sum__chev" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    check: '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    shield: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>',
    truck: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
    lock: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    sedex: '<svg class="ship__ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>',
    correios: '<svg class="ship__ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>',
    pix: '<svg class="pay__ico" viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="5" width="38" height="38" rx="10" transform="rotate(45 24 24)" fill="#32BCAD"/><text x="24" y="29" text-anchor="middle" font-family="Arial,sans-serif" font-weight="800" font-size="13" fill="#fff">PIX</text></svg>',
  };

  const state = {
    slug: null, cfg: null, view: 'form', step: 1, loading: false, error: null, fieldErrors: {},
    data: { name: '', email: '', phone: '', cep: '', street: '', number: '', complement: '', neighborhood: '', city: '', state: '', cpf: '', shippingId: null },
    leadId: null, idemKey: null, order: null, token: null, tracking: {}, poll: null, sumOpen: window.innerWidth >= 900,
  };

  // ---------- rastreamento de campanha (UTMs vindas do funil) ----------
  const TRACK = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'ttclid', 'src', 'sck', 'xcod', 'campaign_id', 'adset_id', 'ad_id'];
  function captureTracking() {
    const saved = ss.get('ck:track') || {};
    const q = new URLSearchParams(location.search);
    for (const k of TRACK) if (q.get(k)) saved[k] = q.get(k).slice(0, 200);
    ss.set('ck:track', saved);
    state.tracking = saved;
  }

  // ---------- API ----------
  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    } catch {
      throw Object.assign(new Error('Sem conexão. Verifique sua internet e tente de novo.'), { code: 'network' });
    }
    let json = null;
    try { json = await res.json(); } catch {}
    if (!res.ok) {
      const e = json?.error || {};
      throw Object.assign(new Error(e.message || 'Algo deu errado. Tente novamente.'), { code: e.code, field: e.field, status: res.status });
    }
    return json;
  }

  // ---------- máscaras e validações ----------
  const mask = {
    phone: (v) => { const d = digits(v).slice(0, 11); if (d.length <= 2) return d; if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`; if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`; return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`; },
    cep: (v) => { const d = digits(v).slice(0, 8); return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d; },
    cpf: (v) => { const d = digits(v).slice(0, 11); return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2'); },
  };
  const isCpf = (v) => {
    const d = digits(v);
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    const calc = (n) => { let s = 0; for (let i = 0; i < n; i++) s += +d[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    return calc(9) === +d[9] && calc(10) === +d[10];
  };
  const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  const isPhone = (v) => { const d = digits(v); return (d.length === 10 || (d.length === 11 && d[2] === '9')) && +d.slice(0, 2) >= 11; };

  const rules = {
    name: (v) => (v.trim().split(/\s+/).filter((p) => p.length > 1).length >= 2 ? '' : 'Informe seu nome completo.'),
    email: (v) => (isEmail(v.trim()) ? '' : 'Informe um e-mail válido.'),
    phone: (v) => (isPhone(v) ? '' : 'Informe um celular válido com DDD.'),
    cep: (v) => (digits(v).length === 8 ? '' : 'Informe um CEP válido.'),
    street: (v) => (v.trim().length >= 3 ? '' : 'Informe a rua.'),
    number: (v) => (v.trim() ? '' : 'Informe o número (ou S/N).'),
    neighborhood: (v) => (v.trim().length >= 2 ? '' : 'Informe o bairro.'),
    city: (v) => (v.trim().length >= 2 ? '' : 'Informe a cidade.'),
    state: (v) => (/^[A-Za-z]{2}$/.test(v.trim()) ? '' : 'Informe o estado (UF).'),
    cpf: (v) => (isCpf(v) ? '' : 'CPF inválido. Confira os números.'),
  };
  const STEP_FIELDS = { 1: ['name', 'email', 'phone'], 2: ['cep', 'street', 'number', 'neighborhood', 'city', 'state'], 3: ['cpf'] };
  const FIELD_STEP = { name: 1, email: 1, phone: 1, cep: 2, street: 2, number: 2, neighborhood: 2, city: 2, state: 2, shippingId: 2, cpf: 3 };

  function validateStep(step) {
    const errs = {};
    for (const f of STEP_FIELDS[step]) { const m = rules[f](state.data[f] || ''); if (m) errs[f] = m; }
    state.fieldErrors = errs;
    return errs;
  }

  // ---------- datas de entrega ----------
  function addBusinessDays(d, n) {
    const x = new Date(d);
    while (n > 0) { x.setDate(x.getDate() + 1); const w = x.getDay(); if (w !== 0 && w !== 6) n--; }
    return x;
  }
  const fmtDay = (d) => d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' }).replace('.', '');
  const etaText = (s, from = new Date()) => (s.minDays === s.maxDays
    ? `Chega até ${fmtDay(addBusinessDays(from, s.maxDays))}`
    : `Chega entre ${fmtDay(addBusinessDays(from, s.minDays))} e ${fmtDay(addBusinessDays(from, s.maxDays))}`);

  // ---------- partes da interface ----------
  const currentShipping = () => state.cfg.shipping.find((s) => s.id === (state.data.shippingId || state.cfg.defaultShippingId));
  function totals() {
    const o = state.order ? state.order.offer : state.cfg.offer;
    const sh = state.order ? state.order.shipping : currentShipping();
    const subtotal = state.order ? state.order.totals.subtotalCents : o.priceCents;
    const ship = state.order ? state.order.totals.shippingCents : sh.priceCents;
    return { o, sh, subtotal, ship, total: subtotal + ship };
  }

  function Summary() {
    const { o, sh, subtotal, ship, total } = totals();
    const pct = Math.round((1 - o.priceCents / o.anchorCents) * 100);
    const box = h('section', { class: `card sum ${state.sumOpen ? 'sum--open' : ''}`, 'aria-label': 'Resumo do pedido' });
    const head = h('button', { type: 'button', class: 'sum__head', 'aria-expanded': String(state.sumOpen), onclick: () => { state.sumOpen = !state.sumOpen; box.classList.toggle('sum--open', state.sumOpen); head.setAttribute('aria-expanded', String(state.sumOpen)); } },
      h('span', { class: 'sum__left' },
        h('img', { class: 'sum__thumb', src: o.image, alt: '', width: 44, height: 44 }),
        h('span', {}, h('span', { class: 'sum__title' }, 'Resumo do pedido'), h('span', { class: 'sum__sub' }, `${o.qty}× ${o.name.replace(/^ECOVOLT /, 'EcoVolt ').toLowerCase().replace(/^ecovolt/, 'EcoVolt')}`))),
      h('span', { style: 'display:flex;align-items:center;gap:8px' }, h('b', {}, brl(total)), h('span', { html: ICON.chev })));
    const body = h('div', { class: 'sum__body' },
      h('div', { class: 'item' },
        h('div', { class: 'item__img' }, h('img', { src: o.image, alt: o.name, width: 84, height: 84 }), h('span', { class: 'item__qty', 'aria-label': `${o.qty} unidades` }, o.qty)),
        h('div', {},
          h('div', { class: 'item__name' }, o.name),
          o.porte ? h('div', { class: 'item__porte' }, o.porte) : null,
          h('div', { class: 'item__prices' }, h('span', { class: 'old' }, brl(o.anchorCents)), h('span', { class: 'now' }, brl(o.priceCents)), h('span', { class: 'off' }, `-${pct}%`)))),
      h('div', { class: 'bonus' },
        h('img', { src: state.cfg.bonus.image, alt: '', width: 52, height: 52 }),
        h('div', {}, h('div', { class: 'bonus__t' }, '🎁 Você ganhou um brinde'), h('div', { class: 'bonus__n' }, state.cfg.bonus.name), h('div', { class: 'bonus__s' }, 'Incluído no seu pedido'))),
      h('div', { class: 'lines' },
        h('div', { class: 'line' }, h('span', {}, `Produto (${o.qty})`), h('span', {}, brl(subtotal))),
        h('div', { class: 'line' }, h('span', {}, sh ? sh.name : 'Frete'), h('span', { class: ship === 0 ? 'free' : '' }, ship === 0 ? 'GRÁTIS' : brl(ship))),
        h('div', { class: 'line line--total' }, h('span', {}, 'Total'), h('span', {}, brl(total)))),
      h('div', { class: 'trust' },
        h('div', { class: 'trust__i' }, h('span', { html: ICON.shield }), '60 dias de garantia: não gostou, devolvemos 100%'),
        h('div', { class: 'trust__i' }, h('span', { html: ICON.truck }), 'Envio em até 24h úteis para todo o Brasil'),
        h('div', { class: 'trust__i' }, h('span', { html: ICON.lock }), 'Seus dados protegidos e criptografados')));
    box.append(head, body);
    return box;
  }

  function Proofs() {
    return h('section', { class: 'card proofs' },
      h('h2', {}, 'O que quem comprou está dizendo'),
      state.cfg.proofs.map((p) => h('div', { class: 'proof' },
        h('img', { class: 'proof__img', src: p.photo, alt: '', width: 44, height: 44, loading: 'lazy' }),
        h('div', {}, h('div', { class: 'proof__n' }, p.name, ' ', h('span', { class: 'stars', 'aria-label': '5 estrelas' }, '★★★★★')), h('p', { class: 'proof__t' }, p.text)))));
  }

  function Steps() {
    const names = ['Identificação', 'Entrega', 'Pagamento'];
    const out = h('div', { class: 'steps', role: 'list' });
    names.forEach((n, i) => {
      const k = i + 1;
      out.append(h('div', { class: `step ${state.step === k ? 'step--on' : ''} ${state.step > k ? 'step--done' : ''}`, role: 'listitem', 'aria-current': state.step === k ? 'step' : null },
        h('span', { class: 'step__n' }, state.step > k ? '✓' : k), h('span', { class: 'step__t' }, n)));
      if (k < 3) out.append(h('span', { class: `step__bar ${state.step > k ? 'step__bar--done' : ''}` }));
    });
    return out;
  }

  // campo de formulário com validação inline
  function Field({ id, label, type = 'text', inputmode, autocomplete, maxlength, placeholder, mk, cls = '', prefix, onblur, readonly }) {
    const err = h('div', { class: 'err', id: `${id}-err`, role: 'alert' }, state.fieldErrors[id] || '');
    const input = h('input', {
      class: 'input', id, name: id, type, inputmode, autocomplete, maxlength, placeholder, readonly: readonly || null, value: state.data[id] || '',
      'aria-invalid': state.fieldErrors[id] ? 'true' : 'false', 'aria-describedby': `${id}-err`,
      oninput: (e) => {
        if (mk) { const pos = e.target.selectionStart; const before = e.target.value.length; e.target.value = mk(e.target.value); const after = e.target.value.length; if (pos != null && pos < before) e.target.setSelectionRange(pos + (after - before), pos + (after - before)); }
        state.data[id] = e.target.value;
        if (state.fieldErrors[id] && !rules[id]?.(e.target.value)) { delete state.fieldErrors[id]; err.textContent = ''; input.setAttribute('aria-invalid', 'false'); }
        saveDraft();
      },
      onblur: (e) => { const m = rules[id]?.(e.target.value || ''); if (m && e.target.value) { state.fieldErrors[id] = m; err.textContent = m; input.setAttribute('aria-invalid', 'true'); } onblur?.(e); },
    });
    const control = prefix ? h('div', { class: 'phone' }, h('span', { class: 'phone__cc' }, prefix), input) : input;
    return h('div', { class: `field ${cls}` }, h('label', { for: id }, label), control, err);
  }
  const showErrors = () => {
    for (const [f, m] of Object.entries(state.fieldErrors)) {
      const el = document.getElementById(`${f}-err`); if (el) el.textContent = m;
      const inp = document.getElementById(f); if (inp) inp.setAttribute('aria-invalid', 'true');
    }
    const first = Object.keys(state.fieldErrors)[0];
    if (first) document.getElementById(first)?.focus({ preventScroll: false });
  };

  const saveDraft = () => ss.set(`ck:${state.slug}`, { data: { ...state.data, cpf: '' }, leadId: state.leadId });
  function loadDraft() {
    const d = ss.get(`ck:${state.slug}`);
    if (d?.data) Object.assign(state.data, d.data);
    if (d?.leadId) state.leadId = d.leadId;
  }

  // ---------- Etapa 1 ----------
  function StepIdentity() {
    const btn = h('button', { class: 'btn', type: 'submit' }, 'Ir para entrega →');
    return h('form', { novalidate: true, autocomplete: 'on', onsubmit: async (e) => {
      e.preventDefault();
      if (Object.keys(validateStep(1)).length) return showErrors();
      // salva o lead (carrinho abandonado) sem travar o cliente
      api('/api/leads', { method: 'POST', body: { slug: state.slug, leadId: state.leadId, name: state.data.name, email: state.data.email, phone: state.data.phone, tracking: state.tracking } })
        .then((r) => { state.leadId = r.leadId; saveDraft(); }).catch(() => {});
      go(2);
    } },
      h('h1', { class: 'title' }, 'Identificação'),
      h('p', { class: 'sub' }, 'Preencha seus dados para o envio do pedido.'),
      Field({ id: 'name', label: 'Nome completo', autocomplete: 'name', maxlength: 120, placeholder: 'Como está no seu documento' }),
      Field({ id: 'email', label: 'E-mail', type: 'email', inputmode: 'email', autocomplete: 'email', maxlength: 254, placeholder: 'voce@email.com' }),
      Field({ id: 'phone', label: 'Celular / WhatsApp', type: 'tel', inputmode: 'tel', autocomplete: 'tel-national', mk: mask.phone, maxlength: 15, placeholder: '(11) 99999-9999', prefix: '+55' }),
      btn,
      h('p', { class: 'legal' }, '🔒 Seus dados estão seguros e só são usados para entregar seu pedido.'));
  }

  // ---------- Etapa 2 ----------
  async function lookupCep() {
    const cep = digits(state.data.cep);
    if (cep.length !== 8) return;
    const status = document.getElementById('cep-status');
    status.replaceChildren(h('span', { class: 'spinner spinner--dark loader-inline' }));
    try {
      const r = await api(`/api/cep/${cep}`);
      Object.assign(state.data, { street: r.street || state.data.street, neighborhood: r.neighborhood || state.data.neighborhood, city: r.city || state.data.city, state: r.state || state.data.state });
      for (const f of ['street', 'neighborhood', 'city', 'state']) { const el = document.getElementById(f); if (el) el.value = state.data[f] || ''; delete state.fieldErrors[f]; const er = document.getElementById(`${f}-err`); if (er) er.textContent = ''; }
      status.textContent = '';
      saveDraft();
      document.getElementById(state.data.street ? 'number' : 'street')?.focus();
    } catch (e) {
      status.textContent = e.code === 'cep_not_found' ? 'CEP não encontrado. Preencha o endereço abaixo.' : 'Preencha o endereço manualmente.';
    }
  }

  function StepDelivery() {
    const ship = h('div', { class: 'ship', role: 'radiogroup', 'aria-label': 'Forma de entrega' },
      state.cfg.shipping.map((s) => h('label', { class: 'ship__opt' },
        h('input', { type: 'radio', name: 'shipping', value: s.id, checked: (state.data.shippingId || state.cfg.defaultShippingId) === s.id, onchange: () => { state.data.shippingId = s.id; saveDraft(); refreshSummary(); } }),
        h('span', { html: ICON[s.icon] || ICON.correios }),
        h('span', { class: 'ship__info' }, h('div', { class: 'ship__name' }, s.name), h('div', { class: 'ship__eta' }, etaText(s))),
        h('span', { class: `ship__price ${s.priceCents === 0 ? 'ship__price--free' : ''}` }, s.priceCents === 0 ? 'GRÁTIS' : brl(s.priceCents)))));
    return h('form', { novalidate: true, autocomplete: 'on', onsubmit: (e) => {
      e.preventDefault();
      if (!state.data.shippingId) state.data.shippingId = state.cfg.defaultShippingId;
      if (Object.keys(validateStep(2)).length) return showErrors();
      go(3);
    } },
      h('h1', { class: 'title' }, 'Entrega'),
      h('p', { class: 'sub' }, `Enviar para ${state.data.name.split(' ')[0]} · `, h('button', { type: 'button', class: 'link', onclick: () => go(1) }, 'alterar dados')),
      h('div', { class: 'field field--sm' },
        h('label', { for: 'cep' }, 'CEP'),
        h('input', { class: 'input', id: 'cep', name: 'postal-code', type: 'text', inputmode: 'numeric', autocomplete: 'postal-code', maxlength: 9, placeholder: '00000-000', value: state.data.cep, 'aria-describedby': 'cep-err',
          'aria-invalid': state.fieldErrors.cep ? 'true' : 'false',
          oninput: (e) => { e.target.value = mask.cep(e.target.value); state.data.cep = e.target.value; delete state.fieldErrors.cep; document.getElementById('cep-err').textContent = ''; saveDraft(); if (digits(e.target.value).length === 8) lookupCep(); } }),
        h('div', { class: 'hint', id: 'cep-status', 'aria-live': 'polite' }),
        h('div', { class: 'err', id: 'cep-err', role: 'alert' }, state.fieldErrors.cep || '')),
      Field({ id: 'street', label: 'Rua / Avenida', autocomplete: 'address-line1', maxlength: 160 }),
      h('div', { class: 'row' },
        Field({ id: 'number', label: 'Número', autocomplete: 'off', maxlength: 20, inputmode: 'text' }),
        Field({ id: 'complement', label: 'Complemento (opcional)', autocomplete: 'address-line2', maxlength: 80 })),
      Field({ id: 'neighborhood', label: 'Bairro', autocomplete: 'address-level3', maxlength: 100 }),
      h('div', { class: 'row row--3' },
        Field({ id: 'city', label: 'Cidade', autocomplete: 'address-level2', maxlength: 100 }),
        Field({ id: 'state', label: 'UF', autocomplete: 'address-level1', maxlength: 2, mk: (v) => v.toUpperCase().replace(/[^A-Z]/g, '') })),
      h('h2', { class: 'title', style: 'font-size:16px;margin:8px 0 8px' }, 'Escolha o frete'),
      ship,
      h('button', { class: 'btn', type: 'submit' }, 'Ir para pagamento →'),
      h('div', { class: 'back' }, h('button', { type: 'button', class: 'link', onclick: () => go(1) }, '← Voltar')));
  }

  // ---------- Etapa 3 ----------
  function StepPayment() {
    const { total } = totals();
    const btn = h('button', { class: 'btn', type: 'submit' }, h('span', { html: ICON.lock }), `Finalizar compra · ${brl(total)}`);
    const alert = h('div', { class: 'alert', role: 'alert', hidden: !state.error }, state.error || '');
    return h('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      if (state.loading) return;
      if (Object.keys(validateStep(3)).length) return showErrors();
      await placeOrder(btn, alert);
    } },
      h('h1', { class: 'title' }, 'Pagamento'),
      h('p', { class: 'sub' }, 'Pague com PIX e receba a confirmação na hora.'),
      alert,
      Field({ id: 'cpf', label: 'CPF do comprador', inputmode: 'numeric', autocomplete: 'off', mk: mask.cpf, maxlength: 14, placeholder: '000.000.000-00' }),
      h('div', { class: 'hint', style: 'margin:-6px 0 14px' }, 'Necessário para emitir o PIX e a nota do pedido.'),
      h('div', { class: 'pay' }, h('span', { html: ICON.pix }), h('div', {}, h('div', { class: 'pay__t' }, 'PIX', h('span', { class: 'badge' }, 'Aprovação imediata')), h('div', { class: 'pay__s' }, 'Você verá o QR Code na próxima tela. Abra o app do seu banco e pague em segundos.'))),
      h('div', { class: 'guarantee' }, h('img', { src: state.cfg.bonus.image, alt: '', width: 54, height: 54 }), h('div', {}, h('b', {}, 'Garantia de 60 dias.'), ' Teste sem risco: se não perceber diferença na sua conta de luz, devolvemos 100% do valor.')),
      btn,
      h('p', { class: 'legal' }, 'Ao finalizar, você concorda com os termos de uso e a política de privacidade.'),
      h('div', { class: 'back' }, h('button', { type: 'button', class: 'link', onclick: () => go(2) }, '← Voltar')));
  }

  async function placeOrder(btn, alert) {
    state.loading = true; state.error = null; alert.hidden = true;
    const label = btn.innerHTML;
    btn.disabled = true; btn.replaceChildren(h('span', { class: 'spinner' }), 'Gerando seu PIX…');
    if (!state.idemKey) state.idemKey = uuid();
    try {
      const d = state.data;
      const r = await api('/api/orders', { method: 'POST', body: {
        slug: state.slug, idempotencyKey: state.idemKey, leadId: state.leadId, shippingId: d.shippingId || state.cfg.defaultShippingId, tracking: state.tracking,
        customer: { name: d.name, email: d.email, phone: d.phone, cpf: d.cpf },
        address: { cep: d.cep, street: d.street, number: d.number, complement: d.complement, neighborhood: d.neighborhood, city: d.city, state: d.state },
      } });
      state.order = r.order; state.token = r.accessToken;
      ss.set(`ck:order`, { id: r.order.id, token: r.accessToken, slug: state.slug });
      history.replaceState(null, '', `/pedido/${r.order.id}?t=${r.accessToken}`);
      state.view = r.order.status === 'paid' ? 'paid' : 'pix';
      render(); window.scrollTo({ top: 0 });
      startPolling();
    } catch (e) {
      state.idemKey = null; // nova tentativa = nova chave
      state.loading = false;
      if (e.field && FIELD_STEP[e.field]) { state.fieldErrors = { [e.field]: e.message }; if (FIELD_STEP[e.field] !== 3) { go(FIELD_STEP[e.field]); return showErrors(); } showErrors(); }
      state.error = e.message; alert.textContent = e.message; alert.hidden = false;
      btn.disabled = false; btn.innerHTML = label;
      alert.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } finally { state.loading = false; }
  }

  // ---------- Tela do PIX ----------
  let pixTimer = null;
  function PixView() {
    const o = state.order;
    const code = o.pix?.qrCode || '';
    const copyBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(code); ok = true; } catch {
        const ta = h('textarea', { style: 'position:fixed;opacity:0', readonly: true }); ta.value = code; document.body.append(ta); ta.select(); try { ok = document.execCommand('copy'); } catch {} ta.remove();
      }
      copyBtn.classList.add('copied'); copyBtn.textContent = ok ? '✓ Código copiado!' : 'Selecione e copie o código acima';
      setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.textContent = 'Copiar código PIX'; }, 2500);
    } }, 'Copiar código PIX');
    const timer = h('span', { class: 'pix__timer', id: 'pixTimer' }, '⏳ …');
    const view = h('section', { class: 'card pixbox' },
      h('h1', {}, 'Falta pouco! Pague seu PIX'),
      h('p', { class: 'sub', style: 'margin-bottom:0' }, 'Seu pedido foi reservado. Pague para garantir sua unidade.'),
      h('div', { class: 'pix__amount' }, brl(o.totals.totalCents)),
      timer,
      h('div', { class: 'qr' }, h('img', { src: o.pix.qrImage, alt: 'QR Code PIX', width: 240, height: 240 })),
      h('div', { class: 'code', id: 'pixCode' }, code),
      copyBtn,
      h('ol', { class: 'how' },
        h('li', {}, 'Abra o app do seu banco e escolha pagar com PIX.'),
        h('li', {}, 'Escaneie o QR Code ou use “PIX Copia e Cola” com o código acima.'),
        h('li', {}, 'Confirme o pagamento. Esta tela atualiza sozinha em segundos.')),
      h('div', { class: 'waiting' }, h('span', { class: 'spinner spinner--dark' }), 'Aguardando a confirmação do pagamento…'));
    clearInterval(pixTimer);
    const exp = o.pix.expiresAt ? Date.parse(o.pix.expiresAt) : 0;
    const tick = () => {
      const el = document.getElementById('pixTimer'); if (!el || !exp) return;
      const left = Math.max(0, exp - Date.now());
      const m = String(Math.floor(left / 60000)).padStart(2, '0'); const s = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
      el.textContent = left ? `⏳ Expira em ${m}:${s}` : 'PIX expirado';
      if (!left) { clearInterval(pixTimer); checkOrder(); }
    };
    setTimeout(tick, 0); pixTimer = setInterval(tick, 1000);
    return view;
  }

  function ExpiredView() {
    return h('section', { class: 'card pixbox' },
      h('h1', {}, 'Este PIX expirou'),
      h('p', { class: 'sub' }, 'Sem problema: gere um novo PIX para concluir seu pedido.'),
      h('button', { class: 'btn', type: 'button', onclick: () => newAttempt() }, 'Gerar novo PIX'));
  }

  function newAttempt() {
    stopPolling(); state.order = null; state.token = null; state.idemKey = null; state.view = 'form'; state.step = 3; state.error = null;
    history.replaceState(null, '', `/c/${state.slug}${location.search.replace(/[?&]t=[^&]*/, '')}`);
    render();
  }

  // ---------- Tela de sucesso ----------
  function PaidView() {
    const o = state.order; const first = o.customer.name.split(' ')[0];
    const a = o.address;
    const paid = o.paidAt ? new Date(o.paidAt) : new Date();
    return h('section', { class: 'card ok' },
      h('div', { class: 'ok__ico', html: ICON.check }),
      h('h1', {}, 'Pagamento confirmado!'),
      h('p', { class: 'sub' }, `Obrigado, ${first}! Seu pedido `, h('span', { class: 'ok__num' }, `#${o.id.slice(0, 8).toUpperCase()}`), ' foi aprovado.'),
      h('div', { class: 'ok__hero' }, h('img', { src: o.offer.image, alt: o.offer.name, width: 220, height: 190 }), h('p', {}, `${o.offer.qty}× EcoVolt`), h('div', { class: 'sub', style: 'margin:2px 0 0' }, o.offer.name)),
      h('div', { class: 'bonus', style: 'text-align:left' }, h('img', { src: state.cfg.bonus.image, alt: '', width: 52, height: 52 }), h('div', {}, h('div', { class: 'bonus__t' }, '🎁 Brinde incluído'), h('div', { class: 'bonus__n' }, state.cfg.bonus.name))),
      h('ul', { class: 'timeline' },
        h('li', {}, h('span', { class: 'tl__dot' }, '1'), h('div', {}, h('b', {}, 'Confirmação por e-mail'), `Enviamos os detalhes para ${o.customer.email}. Confira também o spam.`)),
        h('li', {}, h('span', { class: 'tl__dot' }, '2'), h('div', {}, h('b', {}, 'Preparação e envio'), 'Seu pedido sai em até 24 horas úteis.')),
        h('li', {}, h('span', { class: 'tl__dot' }, '3'), h('div', {}, h('b', {}, 'Entrega estimada'), `${etaText(o.shipping, paid)} · ${o.shipping.name}`))),
      h('div', { class: 'box' }, h('b', {}, 'Endereço de entrega'), `${a.street}, ${a.number}${a.complement ? ' – ' + a.complement : ''} · ${a.neighborhood} · ${a.city}/${a.state} · CEP ${mask.cep(a.zip)}`),
      h('div', { class: 'box' }, h('b', {}, 'Total pago'), `${brl(o.totals.totalCents)} via PIX`),
      h('div', { class: 'box' }, h('b', {}, 'Precisa de ajuda?'), `${state.cfg.store.supportEmail} · ${state.cfg.store.supportPhone}`));
  }

  // ---------- polling ----------
  function stopPolling() { clearInterval(state.poll); state.poll = null; }
  function startPolling() {
    stopPolling();
    if (!state.order || state.order.status !== 'awaiting_payment') return;
    state.poll = setInterval(checkOrder, 4000);
  }
  async function checkOrder() {
    if (!state.order || !state.token) return;
    try {
      const r = await api(`/api/orders/${state.order.id}?t=${encodeURIComponent(state.token)}`);
      const prev = state.order.status; state.order = r.order;
      if (r.order.status !== prev) {
        if (r.order.status === 'paid') { stopPolling(); clearInterval(pixTimer); state.view = 'paid'; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
        else if (['expired', 'failed'].includes(r.order.status)) { stopPolling(); clearInterval(pixTimer); state.view = 'expired'; render(); }
        else if (r.order.status === 'payment_review') { stopPolling(); state.view = 'paid'; render(); }
      }
    } catch (e) { if (e.status === 404) stopPolling(); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkOrder(); });

  // ---------- navegação e render ----------
  function go(step) { if (step > 1 && window.innerWidth < 900) state.sumOpen = false; state.step = step; state.error = null; state.fieldErrors = {}; render(); window.scrollTo({ top: 0 }); }
  function refreshSummary() { const old = document.querySelector('.sum'); if (old) old.replaceWith(Summary()); const btn = document.querySelector('form .btn[type=submit]'); if (btn && state.step === 3) btn.lastChild.textContent = `Finalizar compra · ${brl(totals().total)}`; }

  function render() {
    let main;
    if (state.view === 'pix') main = PixView();
    else if (state.view === 'paid') main = PaidView();
    else if (state.view === 'expired') main = ExpiredView();
    else main = h('section', { class: 'card' }, Steps(), state.step === 1 ? StepIdentity() : state.step === 2 ? StepDelivery() : StepPayment());
    const left = h('div', { class: 'stack' }, main, state.view === 'paid' ? null : Proofs());
    const aside = h('aside', { class: 'aside' }, Summary());
    // no celular o resumo aparece primeiro (como no checkout de referência)
    $app.replaceChildren(h('div', { class: 'grid' }, window.matchMedia('(min-width:900px)').matches ? [left, aside] : [aside, left]));
    renderFooter();
    document.getElementById('scarcity').hidden = state.view !== 'form';
    document.title = (state.view === 'paid' ? 'Pagamento confirmado' : 'Finalizar compra') + ' | EcoVolt';
  }

  function renderFooter() {
    const f = document.getElementById('foot'); const s = state.cfg.store;
    const base = s.funnelUrl;
    f.replaceChildren(
      base ? h('div', { class: 'foot__links' }, [['politicas', 'Política de Privacidade'], ['termos', 'Termos de Uso'], ['devolucao', 'Trocas e Reembolso']].map(([p, t]) => h('a', { href: `${base}/${p}/`, target: '_blank', rel: 'noopener' }, t))) : null,
      h('div', {}, `${s.name} · ${s.supportEmail} · ${s.supportPhone}`),
      h('div', {}, '🔒 Pagamento processado em ambiente seguro. Seus dados são criptografados.'));
  }

  function startScarcity() {
    const bar = document.getElementById('scarcity'); const t = document.getElementById('scarcityTimer');
    if (state.view !== 'form') { bar.hidden = true; return; }
    bar.hidden = false;
    let start = ss.get('ck:bar'); if (!start) { start = Date.now(); ss.set('ck:bar', start); }
    const tick = () => { const left = Math.max(0, 10 * 60000 - (Date.now() - start)); t.hidden = !left; t.textContent = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`; };
    tick(); setInterval(tick, 1000);
  }

  // ---------- inicialização ----------
  async function init() {
    captureTracking();
    const path = location.pathname.split('/').filter(Boolean);
    try {
      if (path[0] === 'pedido' && path[1]) {
        const token = new URLSearchParams(location.search).get('t') || (ss.get('ck:order')?.id === path[1] ? ss.get('ck:order').token : '');
        const r = await api(`/api/orders/${path[1]}?t=${encodeURIComponent(token)}`);
        state.order = r.order; state.token = token; state.slug = r.order.slug;
        state.cfg = await api(`/api/offers/${state.slug}`);
        state.view = r.order.status === 'paid' || r.order.status === 'payment_review' ? 'paid' : r.order.status === 'awaiting_payment' ? 'pix' : 'expired';
        render(); startScarcity(); startPolling();
        return;
      }
      state.slug = path[0] === 'c' && path[1] ? path[1].toLowerCase() : 'ecovolt-2';
      state.cfg = await api(`/api/offers/${state.slug}`);
      state.slug = state.cfg.offer.slug;
      state.data.shippingId = state.cfg.defaultShippingId;
      loadDraft(); state.data.shippingId = state.data.shippingId || state.cfg.defaultShippingId;
      if (!state.cfg.paymentsReady) console.warn('Pagamentos ainda não configurados (chaves da Adex ausentes).');
      render(); startScarcity();
    } catch (e) {
      $app.replaceChildren(h('div', { class: 'boot' }, h('h1', { class: 'title' }, e.status === 404 ? 'Link não encontrado' : 'Não foi possível carregar'), h('p', {}, e.message), h('button', { class: 'btn btn--ghost', style: 'max-width:260px;margin:16px auto 0', onclick: () => location.reload() }, 'Tentar de novo')));
    }
  }
  window.addEventListener('resize', (() => { let w = window.innerWidth >= 900; return () => { const n = window.innerWidth >= 900; if (n !== w && state.cfg) { w = n; const keep = document.activeElement?.id; render(); if (keep) document.getElementById(keep)?.focus(); } }; })());
  init();
})();
