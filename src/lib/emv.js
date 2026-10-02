// Lê o valor (tag 54) de um PIX "copia e cola" (BR Code / EMV-MPM).
// Serve de trava independente da API: o valor que o cliente vai pagar está DENTRO do código.
// Retorna centavos, ou null se o código não tiver valor fixo / não for parseável.
export function pixAmountCents(brcode) {
  const s = String(brcode || '');
  let i = 0;
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!Number.isInteger(len) || len < 0 || i + 4 + len > s.length) return null;
    const val = s.slice(i + 4, i + 4 + len);
    if (tag === '54') {
      if (!/^\d+(\.\d{1,2})?$/.test(val)) return null;
      return Math.round(Number(val) * 100);
    }
    i += 4 + len;
  }
  return null;
}
