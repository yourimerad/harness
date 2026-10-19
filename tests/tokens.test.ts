import { test, expect, describe } from 'claude-code/testing'
import { estimateTokens, formatTokens } from '../hooks/lib/tokens'

describe('estimateTokens', () => {
  test('texte vide : 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  test('arrondit au supérieur : ceil(longueur / 3,5)', () => {
    expect(estimateTokens('a')).toBe(1) // 1 / 3,5
    expect(estimateTokens('abc')).toBe(1) // 3 / 3,5
    expect(estimateTokens('abcd')).toBe(2) // 4 / 3,5
    expect(estimateTokens('a'.repeat(7))).toBe(2) // 7 / 3,5 = 2 pile
    expect(estimateTokens('a'.repeat(8))).toBe(3)
    expect(estimateTokens('a'.repeat(350))).toBe(100)
    expect(estimateTokens('a'.repeat(351))).toBe(101)
  })

  test('compte les unités UTF-16 de la chaîne, espaces et sauts de ligne compris', () => {
    expect(estimateTokens(' ')).toBe(1)
    expect(estimateTokens('\n\n\n\n\n\n\n')).toBe(2)
    expect(estimateTokens('é'.repeat(7))).toBe(2)
  })
})

describe('formatTokens', () => {
  test('sous 1 000 : entier précédé de « ≈ »', () => {
    expect(formatTokens(0)).toBe('≈ 0')
    expect(formatTokens(1)).toBe('≈ 1')
    expect(formatTokens(340)).toBe('≈ 340')
    expect(formatTokens(999)).toBe('≈ 999')
  })

  test('de 1 000 à 9 999 : une décimale et virgule française', () => {
    expect(formatTokens(1000)).toBe('≈ 1,0 k')
    expect(formatTokens(1200)).toBe('≈ 1,2 k')
    expect(formatTokens(1234)).toBe('≈ 1,2 k')
    expect(formatTokens(1250)).toBe('≈ 1,3 k')
    expect(formatTokens(5678)).toBe('≈ 5,7 k')
    expect(formatTokens(9949)).toBe('≈ 9,9 k')
  })

  test('jamais de point décimal', () => {
    for (const n of [1000, 1500, 2345, 7777, 9900]) expect(formatTokens(n)).toMatch(/^≈ \d,\d k$/)
  })

  test('dès 10 000 : sans décimale', () => {
    expect(formatTokens(10000)).toBe('≈ 10 k')
    expect(formatTokens(12000)).toBe('≈ 12 k')
    expect(formatTokens(12345)).toBe('≈ 12 k')
    expect(formatTokens(12500)).toBe('≈ 13 k')
    expect(formatTokens(99999)).toBe('≈ 100 k')
    expect(formatTokens(250000)).toBe('≈ 250 k')
  })

  test('aux frontières, l’arrondi ne fabrique ni « 1000 » ni « 10,0 k »', () => {
    expect(formatTokens(999.4)).toBe('≈ 999')
    expect(formatTokens(999.6)).toBe('≈ 1,0 k')
    expect(formatTokens(9950)).toBe('≈ 10 k')
    expect(formatTokens(9999)).toBe('≈ 10 k')
  })

  test('une valeur fractionnaire est arrondie', () => {
    expect(formatTokens(339.5)).toBe('≈ 340')
    expect(formatTokens(0.4)).toBe('≈ 0')
  })

  test('négatif ou non fini : ramené à 0', () => {
    expect(formatTokens(-5)).toBe('≈ 0')
    expect(formatTokens(Number.NaN)).toBe('≈ 0')
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('≈ 0')
  })

  test('s’accorde avec estimateTokens', () => {
    expect(formatTokens(estimateTokens('a'.repeat(1190)))).toBe('≈ 340')
    expect(formatTokens(estimateTokens('a'.repeat(4200)))).toBe('≈ 1,2 k')
  })
})
