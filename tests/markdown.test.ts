// Tests du module pur hooks/lib/markdown.ts : découpage en unités, retrait, remplacement.
// Pas de `$` : on appelle les fonctions et on vérifie avec expect().
import { test, expect, describe } from 'claude-code/testing'
import { parseUnits, removeUnit, replaceUnit } from '../hooks/lib/markdown'
import type { Unit } from '../hooks/lib/markdown'

/** Unité dont le texte commence par `prefix` ; lève si absente, pour garder les tests lisibles. */
function unit(doc: string, prefix: string): Unit {
  const found = parseUnits(doc).units.find(u => u.text.startsWith(prefix))
  if (!found) throw new Error(`aucune unité ne commence par ${JSON.stringify(prefix)}`)
  return found
}

function removed(doc: string, prefix: string): string | null {
  const r = removeUnit(doc, unit(doc, prefix).id)
  if (!r) throw new Error(`removeUnit a retourné null pour ${JSON.stringify(prefix)}`)
  return r.text
}

const USER_DOC =
  '# Titre\n\n## Machine\n- puce 1\n- puce 2 avec `code`\n\n## Code\n- puce 3\n  - sous-puce\n  suite indentée\n- puce 4\n'

describe('parseUnits : fichier type CLAUDE.md', () => {
  test('quatre puces de premier niveau, avec leurs chemins de titres', () => {
    const doc = parseUnits(USER_DOC)
    expect(doc.frontmatter).toBeNull()
    expect(doc.units).toHaveLength(4)
    expect(doc.units.map(u => u.kind)).toEqual(['bullet', 'bullet', 'bullet', 'bullet'])
    expect(doc.units.map(u => u.title)).toEqual(['puce 1', 'puce 2 avec `code`', 'puce 3', 'puce 4'])
    expect(doc.units.map(u => u.headingPath)).toEqual([
      ['Titre', 'Machine'],
      ['Titre', 'Machine'],
      ['Titre', 'Code'],
      ['Titre', 'Code'],
    ])
    expect(doc.headings).toEqual([
      { level: 1, title: 'Titre', line: 0 },
      { level: 2, title: 'Machine', line: 2 },
      { level: 2, title: 'Code', line: 6 },
    ])
  })

  test('la puce 3 (avec sous-puce et suite indentée) est multi-ligne, la puce 1 est mono-ligne', () => {
    const doc = parseUnits(USER_DOC)
    const [p1, p2, p3, p4] = doc.units
    expect(p1?.isSingleLine).toBe(true)
    expect(p2?.isSingleLine).toBe(true)
    expect(p3?.isSingleLine).toBe(false)
    expect(p4?.isSingleLine).toBe(true)
    expect(p3?.text).toBe('- puce 3\n  - sous-puce\n  suite indentée')
    expect(p3?.start).toBe(7)
    expect(p3?.end).toBe(10)
    expect(p1?.start).toBe(3)
    expect(p1?.end).toBe(4)
  })

  test('text est la tranche exacte des lignes start..end, sans saut de ligne final', () => {
    const lines = USER_DOC.split('\n')
    for (const u of parseUnits(USER_DOC).units) {
      expect(u.text).toBe(lines.slice(u.start, u.end).join('\n'))
      expect(u.text.endsWith('\n')).toBe(false)
    }
  })

  test('texte vide, texte sans unité', () => {
    expect(parseUnits('')).toEqual({ frontmatter: null, headings: [], units: [] })
    expect(parseUnits('\n\n').units).toHaveLength(0)
    const onlyHeadings = parseUnits('# A\n\n## B\n')
    expect(onlyHeadings.units).toHaveLength(0)
    expect(onlyHeadings.headings).toHaveLength(2)
  })
})

describe('parseUnits : titres', () => {
  test('niveaux, séquence de fermeture et saut de niveau', () => {
    const doc = parseUnits('# Un ##\n### Trois\ntexte\n## Deux #\ntexte 2\n')
    expect(doc.headings).toEqual([
      { level: 1, title: 'Un', line: 0 },
      { level: 3, title: 'Trois', line: 1 },
      { level: 2, title: 'Deux', line: 3 },
    ])
    expect(doc.units.map(u => u.headingPath)).toEqual([['Un', 'Trois'], ['Un', 'Deux']])
  })

  test('un titre de même niveau ou supérieur referme les précédents', () => {
    const doc = parseUnits('# A\n## B\n- b\n## C\n- c\n# D\n- d\n')
    expect(doc.units.map(u => u.headingPath)).toEqual([['A', 'B'], ['A', 'C'], ['D']])
  })

  test('#hashtag, sept dièses et titre indenté de quatre espaces ne sont pas des titres', () => {
    const doc = parseUnits('#hashtag\n\n####### sept\n\n    # indenté\n')
    expect(doc.headings).toHaveLength(0)
    expect(doc.units.map(u => u.kind)).toEqual(['paragraph', 'paragraph', 'paragraph'])
  })

  test('les unités avant le premier titre ont un chemin vide', () => {
    const doc = parseUnits('- avant\n\n# Titre\n- après\n')
    expect(doc.units[0]?.headingPath).toEqual([])
    expect(doc.units[1]?.headingPath).toEqual(['Titre'])
  })
})

describe('parseUnits : listes', () => {
  test('listes ordonnées et marqueurs * et +', () => {
    const doc = parseUnits('1. un\n2. deux\n* étoile\n+ plus\n- tiret\n')
    expect(doc.units.map(u => u.kind)).toEqual(['bullet', 'bullet', 'bullet', 'bullet', 'bullet'])
    expect(doc.units.map(u => u.title)).toEqual(['un', 'deux', 'étoile', 'plus', 'tiret'])
    expect(doc.units.every(u => u.isSingleLine)).toBe(true)
  })

  test('le marqueur doit être suivi d\'un blanc : **gras**, -1 et 1.5 ne sont pas des puces', () => {
    const doc = parseUnits('**gras** au début\n\n-1 degré\n\n1.5 million\n')
    expect(doc.units.map(u => u.kind)).toEqual(['paragraph', 'paragraph', 'paragraph'])
  })

  test('une puce emporte ses lignes indentées (espaces ou tabulation) et ses sous-puces', () => {
    const doc = parseUnits('- a\n\tsuite tabulée\n  - sous\n    - sous-sous\n- b\n')
    expect(doc.units).toHaveLength(2)
    expect(doc.units[0]?.text).toBe('- a\n\tsuite tabulée\n  - sous\n    - sous-sous')
    expect(doc.units[1]?.text).toBe('- b')
  })

  test('puce aérée : une ligne vide suivie d\'une ligne indentée reste dans la puce', () => {
    const doc = parseUnits('- a\n\n  suite de a\n\n- b\n')
    expect(doc.units).toHaveLength(2)
    expect(doc.units[0]?.text).toBe('- a\n\n  suite de a')
    expect(doc.units[0]?.end).toBe(3)
    expect(doc.units[1]?.text).toBe('- b')
  })

  test('une ligne vide suivie d\'une ligne non indentée termine la puce', () => {
    const doc = parseUnits('- a\n\nTexte libre\n')
    expect(doc.units.map(u => u.kind)).toEqual(['bullet', 'paragraph'])
  })

  test('texte collé sans indentation : continuation de la puce (un bloc, pas de ligne orpheline)', () => {
    const doc = parseUnits('- une règle longue\nqui continue ici\n- autre\n')
    expect(doc.units).toHaveLength(2)
    expect(doc.units[0]?.text).toBe('- une règle longue\nqui continue ici')
    expect(doc.units[0]?.isSingleLine).toBe(false)
  })

  test('un titre, un fence, une citation ou un tableau collés interrompent la puce', () => {
    const doc = parseUnits('- a\n> cité\n- b\n| x |\n- c\n```\ncode\n```\n- d\n# T\n')
    expect(doc.units.map(u => u.kind)).toEqual(['bullet', 'quote', 'bullet', 'table', 'bullet', 'code', 'bullet'])
    expect(doc.headings).toHaveLength(1)
  })

  test('un fence indenté dans une puce appartient à la puce, même si son contenu est à la marge', () => {
    const doc = parseUnits('- exemple :\n  ```sh\n# commentaire\n- pas une puce\n  ```\n- suivant\n')
    expect(doc.units).toHaveLength(2)
    expect(doc.units[0]?.kind).toBe('bullet')
    expect(doc.units[0]?.text).toBe('- exemple :\n  ```sh\n# commentaire\n- pas une puce\n  ```')
    expect(doc.headings).toHaveLength(0)
  })

  test('texte non indenté juste après un bloc de code fermé dans la puce : nouveau paragraphe, pas une continuation', () => {
    const doc = parseUnits('- a\n  ```\n  x\n  ```\ntexte collé\n')
    expect(doc.units.map(u => u.kind)).toEqual(['bullet', 'paragraph'])
    expect(doc.units[0]?.text).toBe('- a\n  ```\n  x\n  ```')
  })

  test('une puce indentée de 1 à 3 espaces en tête de bloc est une puce de premier niveau', () => {
    const doc = parseUnits(' - a\n - b\n')
    expect(doc.units.map(u => u.text)).toEqual([' - a', ' - b'])
    expect(doc.units.map(u => u.title)).toEqual(['a', 'b'])
  })

  test('le titre d\'une puce est tronqué à 80 caractères', () => {
    const long = 'x'.repeat(200)
    const u = parseUnits(`- ${long}\n`).units[0]
    expect(u?.title.length).toBeLessThanOrEqual(80)
    expect(u?.title.endsWith('…')).toBe(true)
    expect(u?.text).toBe(`- ${long}`)
    const emoji = parseUnits(`- ${'😀'.repeat(100)}\n`).units[0]
    expect(emoji?.title.length).toBeLessThanOrEqual(80)
  })
})

describe('parseUnits : paragraphes', () => {
  test('un paragraphe de plusieurs lignes est une seule unité', () => {
    const doc = parseUnits('ligne 1\nligne 2\nligne 3\n')
    expect(doc.units).toHaveLength(1)
    expect(doc.units[0]?.kind).toBe('paragraph')
    expect(doc.units[0]?.text).toBe('ligne 1\nligne 2\nligne 3')
    expect(doc.units[0]?.isSingleLine).toBe(false)
    expect(doc.units[0]?.title).toBe('ligne 1')
  })

  test('deux paragraphes séparés par une ligne vide sont deux unités', () => {
    const doc = parseUnits('premier\nsuite\n\nsecond\n')
    expect(doc.units).toHaveLength(2)
    expect(doc.units.map(u => u.text)).toEqual(['premier\nsuite', 'second'])
    expect(doc.units[1]?.isSingleLine).toBe(true)
  })

  test('un paragraphe est interrompu par un titre, une puce, un fence, une citation, un tableau', () => {
    const doc = parseUnits('texte\n# Titre\ntexte 2\n- puce\ntexte 3\n```\nc\n```\n> q\n| t |\n')
    expect(doc.units.map(u => u.kind)).toEqual(['paragraph', 'paragraph', 'bullet', 'code', 'quote', 'table'])
  })

  test('seul « 1. » interrompt un paragraphe : « 2026. » en début de ligne reste dans le texte', () => {
    const doc = parseUnits('Nous sommes en\n2026. Voilà\n\ntexte\n1. premier\n')
    expect(doc.units.map(u => u.kind)).toEqual(['paragraph', 'paragraph', 'bullet'])
    expect(doc.units[0]?.text).toBe('Nous sommes en\n2026. Voilà')
  })
})

describe('parseUnits : blocs opaques', () => {
  test('fence ``` avec fausses puces et faux titres : une seule unité code, rien n\'est analysé dedans', () => {
    const doc = parseUnits('# Réel\n\n```ts\n# faux titre\n- fausse puce\n1. faux ordonné\n\n> fausse citation\n```\n\n- vraie\n')
    expect(doc.headings).toHaveLength(1)
    expect(doc.units.map(u => u.kind)).toEqual(['code', 'bullet'])
    expect(doc.units[0]?.text).toBe('```ts\n# faux titre\n- fausse puce\n1. faux ordonné\n\n> fausse citation\n```')
    expect(doc.units[0]?.headingPath).toEqual(['Réel'])
    expect(doc.units[0]?.isSingleLine).toBe(false)
  })

  test('fence ~~~ : même traitement', () => {
    const doc = parseUnits('~~~\n## pas un titre\n- pas une puce\n~~~\n')
    expect(doc.headings).toHaveLength(0)
    expect(doc.units).toHaveLength(1)
    expect(doc.units[0]?.kind).toBe('code')
  })

  test('un fence plus long ne se ferme que par un fence au moins aussi long, du même caractère', () => {
    const doc = parseUnits('````\n```\n- dedans\n~~~~\n````\n- dehors\n')
    expect(doc.units.map(u => u.kind)).toEqual(['code', 'bullet'])
    expect(doc.units[0]?.end).toBe(5)
  })

  test('fence non fermé : jusqu\'à la fin du fichier, sans lignes vides finales', () => {
    const doc = parseUnits('texte\n\n```\n- dedans\n\n')
    expect(doc.units.map(u => u.kind)).toEqual(['paragraph', 'code'])
    expect(doc.units[1]?.text).toBe('```\n- dedans')
  })

  test('``` avec un backtick dans la ligne d\'info est du code en ligne, pas un fence', () => {
    const doc = parseUnits('```code``` en ligne\n')
    expect(doc.units.map(u => u.kind)).toEqual(['paragraph'])
  })

  test('bloc de lignes commençant par | : une unité table', () => {
    const doc = parseUnits('avant\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\naprès\n')
    expect(doc.units.map(u => u.kind)).toEqual(['paragraph', 'table', 'paragraph'])
    expect(doc.units[1]?.text).toBe('| a | b |\n|---|---|\n| 1 | 2 |')
  })

  test('bloc de lignes commençant par > : une unité quote', () => {
    const doc = parseUnits('> citation\n> suite\n>\n> fin\n\napres\n')
    expect(doc.units.map(u => u.kind)).toEqual(['quote', 'paragraph'])
    expect(doc.units[0]?.text).toBe('> citation\n> suite\n>\n> fin')
  })

  test('une ligne @chemin seule est une unité import', () => {
    const doc = parseUnits('# Règles\n\n@~/.claude/rules/x.md\n\n@docs/guide.md\n')
    expect(doc.units.map(u => u.kind)).toEqual(['import', 'import'])
    expect(doc.units[0]?.text).toBe('@~/.claude/rules/x.md')
    expect(doc.units[0]?.isSingleLine).toBe(true)
    expect(doc.units[0]?.headingPath).toEqual(['Règles'])
  })

  test('@mention au milieu d\'une phrase n\'est pas un import ; un import collé à un paragraphe est son unité', () => {
    const doc = parseUnits('Voir @alice pour ça\n\nVoir aussi :\n@~/x.md\n')
    expect(doc.units.map(u => u.kind)).toEqual(['paragraph', 'paragraph', 'import'])
    expect(doc.units[1]?.text).toBe('Voir aussi :')
  })

  test('commentaires HTML sur leurs propres lignes : unité other (une ligne ou plusieurs)', () => {
    const doc = parseUnits('<!-- note -->\n\n<!--\n# pas un titre\n- pas une puce\n-->\n\ntexte\n')
    expect(doc.units.map(u => u.kind)).toEqual(['other', 'other', 'paragraph'])
    expect(doc.units[0]?.text).toBe('<!-- note -->')
    expect(doc.units[1]?.text).toBe('<!--\n# pas un titre\n- pas une puce\n-->')
    expect(doc.headings).toHaveLength(0)
  })

  test('commentaire suivi de texte ou non fermé : du texte ordinaire (la puce qui suit reste une puce)', () => {
    const doc = parseUnits('<!-- a --> puis du texte\n\n<!-- jamais fermé\n- puce\n')
    expect(doc.units.map(u => u.kind)).toEqual(['paragraph', 'paragraph', 'bullet'])
    expect(doc.units[1]?.text).toBe('<!-- jamais fermé')
  })

  test('ligne de séparation --- *** ___ au milieu du fichier : unité other visible', () => {
    const doc = parseUnits('# T\n\n- a\n\n---\n\n- b\n\n***\n')
    expect(doc.units.map(u => u.kind)).toEqual(['bullet', 'other', 'bullet', 'other'])
    expect(doc.units[1]?.text).toBe('---')
  })
})

describe('parseUnits : frontmatter', () => {
  test('---…--- en tête est renvoyé dans frontmatter et n\'est jamais une unité', () => {
    const doc = parseUnits('---\nname: x\n---\n')
    expect(doc.frontmatter).toBe('---\nname: x\n---')
    expect(doc.units).toHaveLength(0)
    expect(doc.headings).toHaveLength(0)
  })

  test('les index de ligne comptent le frontmatter', () => {
    const doc = parseUnits('---\nname: x\ndescription: y\n---\n\n# Titre\n- puce\n')
    expect(doc.frontmatter).toBe('---\nname: x\ndescription: y\n---')
    expect(doc.headings).toEqual([{ level: 1, title: 'Titre', line: 5 }])
    expect(doc.units).toHaveLength(1)
    expect(doc.units[0]?.start).toBe(6)
    expect(doc.units[0]?.end).toBe(7)
  })

  test('lignes vides et listes dans le frontmatter : tout reste dans le frontmatter', () => {
    const doc = parseUnits('---\ntags:\n  - a\n\n  - b\n# pas un titre\n---\ntexte\n')
    expect(doc.frontmatter).toBe('---\ntags:\n  - a\n\n  - b\n# pas un titre\n---')
    expect(doc.headings).toHaveLength(0)
    expect(doc.units.map(u => u.text)).toEqual(['texte'])
  })

  test('un --- plus loin dans le fichier n\'est pas un frontmatter', () => {
    const doc = parseUnits('# Titre\n\ntexte\n\n---\nclé: valeur\n---\n')
    expect(doc.frontmatter).toBeNull()
    expect(doc.units.some(u => u.text === '---')).toBe(true)
  })

  test('un --- en tête sans fermeture n\'est pas un frontmatter', () => {
    const doc = parseUnits('---\n\n- puce\n')
    expect(doc.frontmatter).toBeNull()
    expect(doc.units.map(u => u.kind)).toEqual(['other', 'bullet'])
  })

  test('une ligne vide avant le --- initial : pas de frontmatter', () => {
    const doc = parseUnits('\n---\nname: x\n---\n')
    expect(doc.frontmatter).toBeNull()
  })
})

describe('parseUnits : identifiants', () => {
  test('format h<8 hexadécimaux>-<rang>', () => {
    for (const u of parseUnits(USER_DOC).units) expect(u.id).toMatch(/^h[0-9a-f]{8}-\d+$/)
  })

  test('deux puces identiques ont des ids qui ne diffèrent que par le rang', () => {
    const [a, b, c] = parseUnits('- pareil\n- pareil\n- autre\n').units
    expect(a?.id).not.toBe(b?.id)
    const prefix = (id: string | undefined) => (id ?? '').replace(/-\d+$/, '')
    expect(prefix(a?.id)).toBe(prefix(b?.id))
    expect(prefix(a?.id)).not.toBe(prefix(c?.id))
    expect(a?.id.endsWith('-0')).toBe(true)
    expect(b?.id.endsWith('-1')).toBe(true)
  })

  test('tous les ids d\'un fichier sont distincts', () => {
    const ids = parseUnits('- a\n- a\n\na\n\n- a\n\n> q\n\n> q\n').units.map(u => u.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('même texte, autre titre au-dessus : même hash (le rang départage)', () => {
    const [a, b] = parseUnits('# A\n- x\n# B\n- x\n').units
    expect(a?.id.slice(0, 9)).toBe(b?.id.slice(0, 9))
    expect(a?.id).not.toBe(b?.id)
  })

  test('les blancs de fin de ligne ne changent pas l\'id', () => {
    const a = parseUnits('- texte\n').units[0]
    const b = parseUnits('- texte   \n').units[0]
    expect(a?.id).toBe(b?.id)
  })

  test('stables à la relecture après le retrait d\'une unité sans rapport', () => {
    const doc = '# T\n\n- a\n- b\n- c\n\n## S\n- d\n'
    const before = parseUnits(doc).units
    const r = removeUnit(doc, unit(doc, '- b').id)
    expect(r).not.toBeNull()
    const after = parseUnits(r?.text ?? '').units
    expect(after.map(u => u.text)).toEqual(['- a', '- c', '- d'])
    expect(after.map(u => u.id)).toEqual([before[0]?.id, before[2]?.id, before[3]?.id])
  })

  test('stables aussi quand le retrait supprime un titre vide', () => {
    const doc = '## A\n- a\n\n## B\n- b\n\n## C\n- c\n'
    const before = parseUnits(doc).units
    const r = removeUnit(doc, unit(doc, '- b').id)
    const after = parseUnits(r?.text ?? '').units
    expect(after.map(u => u.id)).toEqual([before[0]?.id, before[2]?.id])
  })
})

describe('parseUnits : fins de ligne Windows', () => {
  test('\\r\\n est normalisé en \\n : aucun \\r dans les unités, mêmes unités que la version \\n', () => {
    const crlf = USER_DOC.replace(/\n/g, '\r\n')
    const a = parseUnits(crlf)
    const b = parseUnits(USER_DOC)
    expect(a).toEqual(b)
    for (const u of a.units) expect(u.text.includes('\r')).toBe(false)
    expect(a.headings.every(h => !h.title.includes('\r'))).toBe(true)
  })

  test('frontmatter en \\r\\n', () => {
    const doc = parseUnits('---\r\nname: x\r\n---\r\n- puce\r\n')
    expect(doc.frontmatter).toBe('---\nname: x\n---')
    expect(doc.units.map(u => u.text)).toEqual(['- puce'])
  })
})

describe('removeUnit', () => {
  test('retire la puce multi-ligne entière et garde le reste intact', () => {
    expect(removed(USER_DOC, '- puce 3')).toBe(
      '# Titre\n\n## Machine\n- puce 1\n- puce 2 avec `code`\n\n## Code\n- puce 4\n',
    )
  })

  test('retourne l\'unité retirée', () => {
    const r = removeUnit(USER_DOC, unit(USER_DOC, '- puce 3').id)
    expect(r?.removed.text).toBe('- puce 3\n  - sous-puce\n  suite indentée')
    expect(r?.removed.headingPath).toEqual(['Titre', 'Code'])
  })

  test('retirer l\'unique puce sous « ## Code » retire aussi le titre « ## Code »', () => {
    const doc = '# Titre\n\n## Machine\n- m\n\n## Code\n- seule\n'
    expect(removed(doc, '- seule')).toBe('# Titre\n\n## Machine\n- m\n')
  })

  test('un titre vide en milieu de fichier est retiré sans laisser de double blanc', () => {
    const doc = '## A\n- a\n\n## B\n- b\n\n## C\n- c\n'
    expect(removed(doc, '- b')).toBe('## A\n- a\n\n## C\n- c\n')
  })

  test('un titre parent qui garde des unités dans un sous-titre reste', () => {
    const doc = '# Titre\n\n## A\n- a\n\n### B\n- b\n'
    expect(removed(doc, '- a')).toBe('# Titre\n\n## A\n\n### B\n- b\n')
  })

  test('les titres vides se retirent en cascade jusqu\'au parent', () => {
    const doc = '# T1\n\n## T1a\n- a\n\n# T2\n- b\n'
    expect(removed(doc, '- a')).toBe('# T2\n- b\n')
  })

  test('un titre déjà vide avant le retrait, sans rapport avec l\'unité, est conservé', () => {
    const doc = '## Vide\n\n## Plein\n- a\n- b\n'
    expect(removed(doc, '- a')).toBe('## Vide\n\n## Plein\n- b\n')
  })

  test('retirer toutes les unités sous « # Titre » (titres imbriqués) donne text null', () => {
    const doc = '# Titre\n\n## A\n- a\n\n### B\n- b\n'
    const first = removeUnit(doc, unit(doc, '- a').id)
    expect(first?.text).toBe('# Titre\n\n## A\n\n### B\n- b\n')
    const rest = first?.text ?? ''
    const last = removeUnit(rest, unit(rest, '- b').id)
    expect(last).not.toBeNull()
    expect(last?.text).toBeNull()
    expect(last?.removed.text).toBe('- b')
  })

  test('la seule unité d\'un fichier : text null', () => {
    expect(removeUnit('- seule\n', unit('- seule\n', '- seule').id)?.text).toBeNull()
    expect(removed('# T\n\n## S\n\n### U\n- seule\n', '- seule')).toBeNull()
  })

  test('dernière unité d\'un fichier avec frontmatter : text null (le fichier est à supprimer)', () => {
    const doc = '---\nname: x\n---\n\nTexte unique.\n'
    expect(removed(doc, 'Texte unique.')).toBeNull()
  })

  test('retirer une unité du milieu laisse au plus une ligne vide entre les voisines', () => {
    expect(removed('- a\n\n- b\n\n- c\n', '- b')).toBe('- a\n\n- c\n')
    expect(removed('para 1\n\npara 2\n\npara 3\n', 'para 2')).toBe('para 1\n\npara 3\n')
    expect(removed('- a\n\n\n\n- b\n\n\n- c\n', '- b')).toBe('- a\n\n- c\n')
  })

  test('puces collées : pas de ligne vide inventée ; une seule si l\'une des deux marges en avait', () => {
    expect(removed('- a\n- b\n- c\n', '- b')).toBe('- a\n- c\n')
    expect(removed('- a\n- b\n\n- c\n', '- b')).toBe('- a\n\n- c\n')
    expect(removed('- a\n\n- b\n- c\n', '- b')).toBe('- a\n\n- c\n')
  })

  test('conserve le saut de ligne final, et son absence', () => {
    expect(removed('- a\n- b\n', '- b')).toBe('- a\n')
    expect(removed('- a\n- b', '- b')).toBe('- a')
    expect(removed('- a\n- b\n- c', '- a')).toBe('- b\n- c')
  })

  test('pas de blancs de fin', () => {
    expect(removed('- a\n- b\n\n\n\n', '- b')).toBe('- a\n')
    expect(removed('# T\n- a\n\n- b\n\n\n', '- b')).toBe('# T\n- a\n')
  })

  test('retirer la première unité ne laisse pas de ligne vide en tête', () => {
    expect(removed('- a\n\n- b\n', '- a')).toBe('- b\n')
    expect(removed('# T\n\n- a\n\n- b\n', '- a')).toBe('# T\n\n- b\n')
  })

  test('le frontmatter est conservé tel quel', () => {
    const doc = '---\nname: x\n---\n\n- a\n\n- b\n'
    expect(removed(doc, '- a')).toBe('---\nname: x\n---\n\n- b\n')
  })

  test('les blancs éloignés du retrait ne sont pas touchés', () => {
    expect(removed('- a\n\n\n- b\n\n- c\n', '- c')).toBe('- a\n\n\n- b\n')
  })

  test('les lignes vides dans un bloc de code conservé ne sont jamais modifiées', () => {
    const doc = '- a\n\n```\nx\n\n\ny\n```\n\n- b\n'
    expect(removed(doc, '- a')).toBe('```\nx\n\n\ny\n```\n\n- b\n')
  })

  test('retirer un bloc de code, un tableau, une citation, un import, un commentaire', () => {
    const doc = '# T\n\n```\n- x\n```\n\n| a |\n\n> q\n\n@x.md\n\n<!-- c -->\n\n- fin\n'
    expect(removed(doc, '```')).toBe('# T\n\n| a |\n\n> q\n\n@x.md\n\n<!-- c -->\n\n- fin\n')
    expect(removed(doc, '| a |')).toBe('# T\n\n```\n- x\n```\n\n> q\n\n@x.md\n\n<!-- c -->\n\n- fin\n')
    expect(removed(doc, '> q')).toBe('# T\n\n```\n- x\n```\n\n| a |\n\n@x.md\n\n<!-- c -->\n\n- fin\n')
    expect(removed(doc, '@x.md')).toBe('# T\n\n```\n- x\n```\n\n| a |\n\n> q\n\n<!-- c -->\n\n- fin\n')
    expect(removed(doc, '<!-- c -->')).toBe('# T\n\n```\n- x\n```\n\n| a |\n\n> q\n\n@x.md\n\n- fin\n')
  })

  test('retirer un bloc collé entre deux paragraphes ne les fusionne pas', () => {
    const doc = 'para1\n```\ncode\n```\npara2\n'
    const out = removed(doc, '```')
    expect(out).toBe('para1\n\npara2\n')
    expect(parseUnits(out ?? '').units.map(u => u.text)).toEqual(['para1', 'para2'])
  })

  test('retirer un bloc collé entre deux citations (ou deux tableaux) ne les fusionne pas', () => {
    expect(removed('> a\n```\nx\n```\n> b\n', '```')).toBe('> a\n\n> b\n')
    expect(removed('| a |\n> q\n| b |\n', '> q')).toBe('| a |\n\n| b |\n')
  })

  test('retirer un bloc entre une puce et du texte collé ne fait pas absorber le texte par la puce', () => {
    const out = removed('- a\n```\nx\n```\ntexte\n', '```')
    expect(out).toBe('- a\n\ntexte\n')
    expect(parseUnits(out ?? '').units.map(u => u.kind)).toEqual(['bullet', 'paragraph'])
  })

  test('un --- devenu première ligne n\'est pas relu comme un frontmatter', () => {
    const doc = 'para\n\n---\n\ntexte\n\n---\n\nfin\n'
    const out = removed(doc, 'para') ?? ''
    const reparsed = parseUnits(out)
    expect(reparsed.frontmatter).toBeNull()
    expect(reparsed.units.map(u => u.text)).toEqual(['---', 'texte', '---', 'fin'])
  })

  test('un id inexistant donne null', () => {
    expect(removeUnit(USER_DOC, 'h00000000-0')).toBeNull()
    expect(removeUnit(USER_DOC, '')).toBeNull()
    expect(removeUnit('', 'h00000000-0')).toBeNull()
  })

  test('avec deux puces identiques, le rang désigne celle qui part', () => {
    const doc = '- pareil\n- autre\n- pareil\n'
    const [first, , second] = parseUnits(doc).units
    expect(removeUnit(doc, second?.id ?? '')?.text).toBe('- pareil\n- autre\n')
    expect(removeUnit(doc, first?.id ?? '')?.text).toBe('- autre\n- pareil\n')
  })

  test('\\r\\n en entrée : la sortie est en \\n', () => {
    const out = removeUnit('# T\r\n\r\n- a\r\n- b\r\n', unit('# T\n\n- a\n- b\n', '- a').id)
    expect(out?.text).toBe('# T\n\n- b\n')
    expect(out?.text?.includes('\r')).toBe(false)
  })

  test('aller-retour : retirer chaque unité du fichier type laisse les autres unités intactes', () => {
    const before = parseUnits(USER_DOC).units
    for (const u of before) {
      const r = removeUnit(USER_DOC, u.id)
      const after = parseUnits(r?.text ?? '').units
      expect(after.map(x => x.text)).toEqual(before.filter(x => x.id !== u.id).map(x => x.text))
    }
  })
})

describe('replaceUnit', () => {
  test('puce mono-ligne : « new » donne « - new »', () => {
    const doc = '# T\n\n- old\n- autre\n'
    expect(replaceUnit(doc, unit(doc, '- old').id, 'new')).toBe('# T\n\n- new\n- autre\n')
  })

  test('puce mono-ligne : « - new » donne « - new » (marqueur non doublé)', () => {
    const doc = '# T\n\n- old\n- autre\n'
    expect(replaceUnit(doc, unit(doc, '- old').id, '- new')).toBe('# T\n\n- new\n- autre\n')
  })

  test('le marqueur d\'origine est conservé : *, +, numéro, espacement', () => {
    const doc = '* star\n+ plus\n2. deux\n-   large\n'
    expect(replaceUnit(doc, unit(doc, '* star').id, 'x')).toBe('* x\n+ plus\n2. deux\n-   large\n')
    expect(replaceUnit(doc, unit(doc, '+ plus').id, 'x')).toBe('* star\n+ x\n2. deux\n-   large\n')
    expect(replaceUnit(doc, unit(doc, '2. deux').id, 'x')).toBe('* star\n+ plus\n2. x\n-   large\n')
    expect(replaceUnit(doc, unit(doc, '-   large').id, 'x')).toBe('* star\n+ plus\n2. deux\n-   x\n')
  })

  test('un nouveau texte qui porte son propre marqueur le garde', () => {
    const doc = '- old\n'
    expect(replaceUnit(doc, unit(doc, '- old').id, '* new')).toBe('* new\n')
    expect(replaceUnit(doc, unit(doc, '- old').id, '1. new')).toBe('1. new\n')
  })

  test('un texte qui commence par un tiret collé n\'est pas un marqueur', () => {
    const doc = '- old\n'
    expect(replaceUnit(doc, unit(doc, '- old').id, '-1 degré')).toBe('- -1 degré\n')
  })

  test('une puce indentée de 1 à 3 espaces garde son indentation', () => {
    const doc = ' - old\n'
    expect(replaceUnit(doc, unit(doc, ' - old').id, 'new')).toBe(' - new\n')
    expect(replaceUnit(doc, unit(doc, ' - old').id, '- new')).toBe(' - new\n')
  })

  test('les blancs autour du nouveau texte sont retirés', () => {
    const doc = '- old\n'
    expect(replaceUnit(doc, unit(doc, '- old').id, '  new  \n')).toBe('- new\n')
  })

  test('une unité multi-ligne donne null', () => {
    expect(replaceUnit(USER_DOC, unit(USER_DOC, '- puce 3').id, 'new')).toBeNull()
    const para = 'ligne 1\nligne 2\n'
    expect(replaceUnit(para, unit(para, 'ligne 1').id, 'new')).toBeNull()
    const code = '```\nx\n```\n'
    expect(replaceUnit(code, unit(code, '```').id, 'new')).toBeNull()
  })

  test('un id inconnu donne null', () => {
    expect(replaceUnit(USER_DOC, 'h00000000-0', 'new')).toBeNull()
  })

  test('un nouveau texte vide ou sur plusieurs lignes donne null', () => {
    const doc = '- old\n'
    const id = unit(doc, '- old').id
    expect(replaceUnit(doc, id, '')).toBeNull()
    expect(replaceUnit(doc, id, '   ')).toBeNull()
    expect(replaceUnit(doc, id, 'a\nb')).toBeNull()
    expect(replaceUnit(doc, id, 'a\r\nb')).toBeNull()
  })

  test('un paragraphe ou un import d\'une ligne est remplacé tel quel', () => {
    const doc = 'texte seul\n\n@a.md\n'
    expect(replaceUnit(doc, unit(doc, 'texte seul').id, 'autre texte')).toBe('autre texte\n\n@a.md\n')
    expect(replaceUnit(doc, unit(doc, '@a.md').id, '@b.md')).toBe('texte seul\n\n@b.md\n')
  })

  test('le reste du fichier est intact : frontmatter, blancs multiples, absence de saut de ligne final', () => {
    const doc = '---\nname: x\n---\n\n\n# T\n- old\n\n\n- z'
    expect(replaceUnit(doc, unit(doc, '- old').id, 'new')).toBe('---\nname: x\n---\n\n\n# T\n- new\n\n\n- z')
  })

  test('\\r\\n en entrée : la sortie est en \\n', () => {
    const crlf = '# T\r\n- old\r\n- z\r\n'
    const id = unit('# T\n- old\n- z\n', '- old').id
    const out = replaceUnit(crlf, id, 'new')
    expect(out).toBe('# T\n- new\n- z\n')
  })

  test('le résultat se relit : une unité mono-ligne de plus avec le nouveau titre', () => {
    const doc = '- old\n- autre\n'
    const out = replaceUnit(doc, unit(doc, '- old').id, 'nouveau texte') ?? ''
    expect(parseUnits(out).units.map(u => u.title)).toEqual(['nouveau texte', 'autre'])
  })
})
