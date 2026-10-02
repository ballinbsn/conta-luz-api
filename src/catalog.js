// Catálogo e preços ficam SEMPRE no servidor: o navegador nunca define valores.
// Preços iguais aos da página de ofertas do funil (R$ 49 / 97 / 147).

export const OFFERS = {
  'ecovolt-1': { slug: 'ecovolt-1', name: 'ECOVOLT 1 UNIDADE', qty: 1, priceCents: 4900, anchorCents: 9900, image: '/img/ecovolt-01.png', porte: 'Casa pequena · até 40 m²' },
  'ecovolt-2': { slug: 'ecovolt-2', name: 'ECOVOLT 2 UNIDADES', qty: 2, priceCents: 9700, anchorCents: 19800, image: '/img/ecovolt-02.png', porte: 'Casa média · 40 a 60 m²' },
  'ecovolt-3': { slug: 'ecovolt-3', name: 'ECOVOLT 3 UNIDADES', qty: 3, priceCents: 14700, anchorCents: 29700, image: '/img/ecovolt-03.png', porte: 'Casa grande · acima de 60 m²' },
};

// Mesmas opções de frete do checkout de referência.
export const SHIPPING = [
  { id: 'gratis', name: 'Frete Grátis', priceCents: 0, minDays: 7, maxDays: 12, icon: 'correios' },
  { id: 'sedex', name: 'Frete Sedex', priceCents: 1852, minDays: 5, maxDays: 5, icon: 'sedex' },
  { id: 'correios', name: 'Frete Correios', priceCents: 1450, minDays: 4, maxDays: 7, icon: 'correios' },
];
export const DEFAULT_SHIPPING_ID = 'gratis';

export const BONUS = { name: 'Garantia Vitalícia', image: '/img/brinde-garantia.webp' };

export const PROOFS = [
  { name: 'Marcos A.', photo: '/img/prova-1.jpeg', text: 'Pensei que era mentira, mas a conta que era 320 baixou pra 110.... indico pro pessoal' },
  { name: 'Emerso J.', photo: '/img/prova-2.jpeg', text: 'Aqui funcionou! Se soubesse tinha comprado antes...' },
  { name: 'Anderson P.', photo: '/img/prova-3.jpeg', text: 'Produto muito bom. Valeu a pena demais' },
  { name: 'Fatima M.', photo: '/img/prova-4.jpeg', text: 'Gente do céu que bença esse produto!!! Chega de ser roubada!!! Muito bom e recomendo para todos!!!' },
];

// ecovolt-2-bk -> ecovolt-2
export function normalizeSlug(slug) {
  return String(slug || '').toLowerCase().trim().replace(/-bk$/, '');
}
export function getOffer(slug) {
  return OFFERS[normalizeSlug(slug)] || null;
}
export function getShipping(id) {
  return SHIPPING.find((s) => s.id === id) || null;
}

export function computeTotals(offer, shipping) {
  const subtotalCents = offer.priceCents;
  const shippingCents = shipping.priceCents;
  return { subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents };
}
