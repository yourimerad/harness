import { test, expect, describe } from 'claude-code/testing'
import { formatEntry } from '../hooks/lib/journal'
import type { JournalAction, JournalEntry } from '../hooks/lib/journal'

const AT = '2026-10-19T10:00:00.000Z'

const base: JournalEntry = { at: AT, action: 'remove-unit', target: '/Users/y/.claude/CLAUDE.md' }

describe('formatEntry : en-tête', () => {
  test('commence par « ## <at> · <action> · <target> »', () => {
    expect(formatEntry(base)).toBe(`## ${AT} · remove-unit · /Users/y/.claude/CLAUDE.md\n`)
  })

  test('chaque action apparaît telle quelle dans l’en-tête', () => {
    const actions: JournalAction[] = [
      'remove-unit',
      'remove-file',
      'edit-unit',
      'remove-key',
      'set-key',
      'disable-plugin',
      'disable-skill',
      'remove-hook',
    ]
    for (const action of actions) {
      expect(formatEntry({ ...base, action }).split('\n')[0]).toBe(`## ${AT} · ${action} · /Users/y/.claude/CLAUDE.md`)
    }
  })

  test('un saut de ligne dans la cible ou l’horodatage ne casse pas l’en-tête', () => {
    const out = formatEntry({ ...base, at: `${AT}\n`, target: 'a\nb\r\n## c' })
    expect(out).toBe(`## ${AT} · remove-unit · a b ## c\n`)
    expect(out.split('\n')).toHaveLength(2) // l’en-tête puis la fin
  })
})

describe('formatEntry : fin de l’entrée', () => {
  test('se termine par exactement un saut de ligne, quel que soit le contenu', () => {
    const entries: JournalEntry[] = [
      base,
      { ...base, note: 'une note' },
      { ...base, note: 'une note\n\n' },
      { ...base, before: 'avant' },
      { ...base, before: 'avant\n' },
      { ...base, before: 'avant\n\n\n' },
      { ...base, before: 'avant', after: 'après\n' },
      { ...base, before: '', after: '' },
      { ...base, after: '```\n' },
      { ...base, note: 'n', before: 'b\n', after: 'a\n' },
    ]
    for (const e of entries) {
      const out = formatEntry(e)
      expect(out.endsWith('\n')).toBe(true)
      expect(out.endsWith('\n\n')).toBe(false)
    }
  })
})

describe('formatEntry : note', () => {
  test('une note courte vient après l’en-tête, en citation', () => {
    expect(formatEntry({ ...base, note: 'Retiré depuis le pane Harnais.' })).toBe(
      `## ${AT} · remove-unit · /Users/y/.claude/CLAUDE.md\n\n> Retiré depuis le pane Harnais.\n`,
    )
  })

  test('une note sur plusieurs lignes : chaque ligne citée, les lignes vides aussi', () => {
    const out = formatEntry({ ...base, note: 'ligne 1\n\nligne 3' })
    expect(out).toBe(`## ${AT} · remove-unit · /Users/y/.claude/CLAUDE.md\n\n> ligne 1\n>\n> ligne 3\n`)
  })

  test('une note qui contient « ## » ou une clôture ne déborde pas de la citation', () => {
    const out = formatEntry({ ...base, note: '## faux titre\n```js' })
    expect(out).toBe(`## ${AT} · remove-unit · /Users/y/.claude/CLAUDE.md\n\n> ## faux titre\n> \`\`\`js\n`)
    expect(out.split('\n').filter(line => line.startsWith('## '))).toHaveLength(1)
  })

  test('une note vide ou blanche est ignorée', () => {
    expect(formatEntry({ ...base, note: '' })).toBe(formatEntry(base))
    expect(formatEntry({ ...base, note: ' \n ' })).toBe(formatEntry(base))
  })
})

describe('formatEntry : before / after', () => {
  test('avant seul : libellé puis bloc de code', () => {
    expect(formatEntry({ ...base, before: '- une règle' })).toBe(
      `## ${AT} · remove-unit · /Users/y/.claude/CLAUDE.md\n\n**Avant**\n\n\`\`\`\n- une règle\n\`\`\`\n`,
    )
  })

  test('après seul', () => {
    expect(formatEntry({ ...base, action: 'set-key', after: '{"a": 1}' })).toBe(
      `## ${AT} · set-key · /Users/y/.claude/CLAUDE.md\n\n**Après**\n\n\`\`\`\n{"a": 1}\n\`\`\`\n`,
    )
  })

  test('note, avant puis après, dans cet ordre', () => {
    const out = formatEntry({ ...base, action: 'edit-unit', note: 'n', before: 'ancien', after: 'nouveau' })
    expect(out).toBe(
      [
        `## ${AT} · edit-unit · /Users/y/.claude/CLAUDE.md`,
        '',
        '> n',
        '',
        '**Avant**',
        '',
        '```',
        'ancien',
        '```',
        '',
        '**Après**',
        '',
        '```',
        'nouveau',
        '```',
        '',
      ].join('\n'),
    )
  })

  test('ni avant ni après : aucun bloc', () => {
    const out = formatEntry({ ...base, note: 'seulement une note' })
    expect(out).not.toContain('```')
    expect(out).not.toContain('Avant')
    expect(out).not.toContain('Après')
  })

  test('contenu vide (« » ≠ undefined) : bloc affiché, sans ligne vide dedans', () => {
    expect(formatEntry({ ...base, action: 'remove-file', before: 'x', after: '' })).toBe(
      `## ${AT} · remove-file · /Users/y/.claude/CLAUDE.md\n\n**Avant**\n\n\`\`\`\nx\n\`\`\`\n\n**Après**\n\n\`\`\`\n\`\`\`\n`,
    )
  })

  test('le saut de ligne final du contenu (un seul) n’ajoute pas de ligne vide dans le bloc', () => {
    const one = formatEntry({ ...base, before: 'a\n' })
    expect(one).toBe(formatEntry({ ...base, before: 'a' }))
    expect(formatEntry({ ...base, before: 'a\r\n' })).toBe(formatEntry({ ...base, before: 'a' }))
    expect(formatEntry({ ...base, before: 'a\n\n' })).toBe(`## ${AT} · remove-unit · /Users/y/.claude/CLAUDE.md\n\n**Avant**\n\n\`\`\`\na\n\n\`\`\`\n`)
  })

  test('les lignes du contenu sont gardées telles quelles (indentation, blancs, CRLF intérieur)', () => {
    const before = '- puce\n  - sous-puce\n\n    code  \r\n\ttab'
    expect(formatEntry({ ...base, before })).toBe(`## ${AT} · remove-unit · /Users/y/.claude/CLAUDE.md\n\n**Avant**\n\n\`\`\`\n${before}\n\`\`\`\n`)
  })
})

describe('formatEntry : clôture plus longue que les backticks du contenu', () => {
  const entryFor = (before: string): string[] => formatEntry({ ...base, before }).split('\n')

  test('sans backtick : clôture de 3', () => {
    expect(entryFor('texte')).toEqual([`## ${AT} · remove-unit · /Users/y/.claude/CLAUDE.md`, '', '**Avant**', '', '```', 'texte', '```', ''])
  })

  test('code en ligne (1 ou 2 backticks) : la clôture reste à 3', () => {
    expect(entryFor('utiliser `pnpm` ou ``pnpm run``')).toContain('```')
    expect(entryFor('utiliser `pnpm` ou ``pnpm run``').filter(l => l === '````')).toHaveLength(0)
  })

  test('contenu avec ``` : clôture de 4', () => {
    const lines = entryFor('avant\n```ts\nconst x = 1\n```\naprès')
    expect(lines).toEqual([
      `## ${AT} · remove-unit · /Users/y/.claude/CLAUDE.md`,
      '',
      '**Avant**',
      '',
      '````',
      'avant',
      '```ts',
      'const x = 1',
      '```',
      'après',
      '````',
      '',
    ])
  })

  test('contenu avec 4 backticks : clôture de 5 ; avec 7 : clôture de 8', () => {
    expect(entryFor('````\nx\n````')).toContain('`````')
    const eight = entryFor('`'.repeat(7))
    expect(eight).toContain('`'.repeat(8))
    expect(eight).toContain('`'.repeat(7)) // le contenu lui-même
  })

  test('la plus longue suite compte, où qu’elle soit (milieu de ligne, fin de contenu)', () => {
    expect(entryFor('a ``` b')).toContain('````')
    expect(entryFor('fin ```')).toContain('````')
    expect(entryFor('`` puis ````` puis `')).toContain('``````')
  })

  test('la clôture ouvrante et la clôture fermante sont identiques, et le contenu ne peut pas la refermer', () => {
    for (const content of ['```', '```\n```', '````md\n```\n````', '`'.repeat(20)]) {
      const lines = entryFor(content)
      const open = lines.indexOf('**Avant**') + 2
      const fence = lines[open]
      expect(fence).toBeDefined()
      const close = lines.lastIndexOf(fence as string)
      expect(close).toBeGreaterThan(open)
      expect(fence).toMatch(/^`{3,}$/)
      // Aucune ligne du contenu n’est faite d’autant de backticks que la clôture (ou plus) : elle ne peut pas la fermer.
      for (const line of lines.slice(open + 1, close)) {
        const run = /^ {0,3}(`+)\s*$/.exec(line)?.[1]
        if (run !== undefined) expect(run.length).toBeLessThan((fence as string).length)
      }
    }
  })

  test('chaque bloc (avant et après) calcule sa propre clôture', () => {
    const out = formatEntry({ ...base, action: 'edit-unit', before: '```\nx\n```', after: 'sans backtick' })
    const lines = out.split('\n')
    expect(lines.filter(l => l === '````')).toHaveLength(2) // le bloc « avant »
    expect(lines.filter(l => l === '```')).toHaveLength(4) // 2 lignes de contenu + les 2 clôtures du bloc « après »
  })
})
