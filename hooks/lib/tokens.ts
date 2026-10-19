// Estimation et affichage des tokens. Pur : aucune API Node ni DOM.

/** Estimation grossière : 3,5 caractères par token. 0 pour le texte vide. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

/** Au-delà, l'affichage reste « ≈ 999 M » : un entier géant s'écrirait en notation exponentielle (`1e+21`). */
const MAX_MILLIONS = 999

/**
 * Affichage court d'un nombre de tokens, en français :
 * - sous 1 000 : `≈ 340` ;
 * - de 1 000 à 9 949 : une décimale et virgule française, `≈ 1,2 k` (`≈ 1,0 k` pour 1 000) ;
 * - dès 10 000 (ou dès que l'arrondi à la décimale atteint 10,0 k) : sans décimale, `≈ 12 k` ;
 * - dès 999 500 (l'arrondi atteindrait « 1000 k ») : en millions, `≈ 1,2 M` (`≈ 1,0 M` pour 1 000 000) ;
 * - dès 10 M (ou dès que l'arrondi atteint 10,0 M) : sans décimale, `≈ 12 M` ;
 * - plafonné à `≈ 999 M` : jamais de notation exponentielle.
 *
 * Une valeur non finie ou négative est ramenée à 0 ; une valeur fractionnaire est arrondie.
 */
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) ? Math.round(Math.max(0, n)) : 0
  if (v < 1000) return `≈ ${v}`
  if (v < 999_500) {
    // Dixièmes de millier, arrondis : 9 950 → 100 dixièmes → bascule en « 10 k » plutôt que « 10,0 k ».
    const tenths = Math.round(v / 100)
    if (tenths < 100) return `≈ ${Math.floor(tenths / 10)},${tenths % 10} k`
    return `≈ ${Math.round(v / 1000)} k`
  }
  // Même logique en millions : 9 950 000 → « 10 M » ; 999 500 000 et plus → plafond.
  const tenths = Math.round(v / 100_000)
  if (tenths < 100) return `≈ ${Math.floor(tenths / 10)},${tenths % 10} M`
  return `≈ ${Math.min(Math.round(v / 1_000_000), MAX_MILLIONS)} M`
}
