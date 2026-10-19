import { describe, expect, test } from 'claude-code/testing'

import type { HarnessItem as Item } from '../types'
import { appendJournal, fillPromptForEdit, isWritable, runDisable, runInlineEdit, type ActionIo } from '../hooks/lib/actions'
import { parseUnits } from '../hooks/lib/markdown'

const HOME = '/Users/y'
const env = { home: HOME, root: '/Users/y/proj', now: async () => '2026-10-19T10:00:00.000Z' }
const JOURNAL = `${HOME}/.claude/harness/journal.md`

/** Un système de fichiers en mémoire, avec la trace des commandes lancées. */
const fakeIo = (files: Record<string, string>, box = '') => {
  const fs = new Map(Object.entries(files))
  const runs: string[][] = []
  const fills: Array<{ text: string; mode: string }> = []
  const io: ActionIo = {
    readText: async path => fs.get(path) ?? null,
    write: async (path, text) => void fs.set(path, text),
    run: async argv => {
      runs.push(argv)
      if (argv[0] === 'rm') fs.delete(argv[2] ?? '')
      if (argv[0] === 'mv') {
        for (const [k, v] of [...fs]) if (k.startsWith(`${argv[2]}/`)) { fs.set(k.replace(argv[2]!, argv[3]!), v); fs.delete(k) }
      }
      return { exitCode: 0, stderr: '' }
    },
    promptRead: async () => ({ text: box }),
    promptFill: async args => { fills.push(args); return { isFilled: true } },
  }
  return { io, fs, runs, fills }
}

const CLAUDE = `${HOME}/.claude/CLAUDE.md`
const unitItem = (unitId: string, title = 'puce'): Item => ({
  id: `claudeMd/${CLAUDE}#${unitId}`, group: 'claudeMd', title, text: `- ${title}`, tokens: 2, vanilla: false,
  source: { kind: 'file', path: CLAUDE, tier: 'user' }, disable: { kind: 'remove-unit', path: CLAUDE, unitId }, edit: 'inline',
})

describe('périmètre', () => {
  test('refuse plugins/, dev-mods/ et les chemins relatifs ou remontants', () => {
    expect(isWritable(`${HOME}/.claude/plugins/cache/hcc/hooks/hooks.json`, env)).toBe(false)
    expect(isWritable(`${HOME}/.claude/dev-mods/x/harness/hooks/register.tsx`, env)).toBe(false)
    expect(isWritable('relatif/CLAUDE.md', env)).toBe(false)
    expect(isWritable(`${HOME}/.claude/../.ssh/config`, env)).toBe(false)
    expect(isWritable(CLAUDE, env)).toBe(true)
    expect(isWritable(`${HOME}/.claude/settings.json`, env)).toBe(true)
  })
})

describe('journal', () => {
  test('crée le journal avec un en-tête puis ajoute à la fin', async () => {
    const { io, fs } = fakeIo({})
    await appendJournal(io, env, { action: 'remove-key', target: 'a', before: '1' })
    await appendJournal(io, env, { action: 'remove-key', target: 'b', before: '2' })
    const j = fs.get(JOURNAL) ?? ''
    expect(j.startsWith('# Journal harness')).toBe(true)
    expect(j.indexOf('· a') < j.indexOf('· b')).toBe(true)
  })
})

describe('runDisable : unités markdown', () => {
  test('retire une puce, journalise, invalide prompt.context', async () => {
    const { io, fs } = fakeIo({ [CLAUDE]: '# T\n\n- un\n- deux\n' })
    const u = parseUnits(fs.get(CLAUDE)!).units[0]!
    const res = await runDisable(io, env, unitItem(u.id, 'un'))
    expect(res.ok).toBe(true)
    expect(res.invalidate).toEqual(['prompt.context'])
    expect(fs.get(CLAUDE)).toBe('# T\n\n- deux\n')
    expect(fs.get(JOURNAL)).toContain('- un')
  })

  test('la dernière unité retirée supprime le fichier via rm et le dit', async () => {
    const { io, fs, runs } = fakeIo({ [CLAUDE]: '# T\n\n- seule\n' })
    const u = parseUnits(fs.get(CLAUDE)!).units[0]!
    const res = await runDisable(io, env, unitItem(u.id, 'seule'))
    expect(res.ok).toBe(true)
    expect(res.removedFile).toBe(CLAUDE)
    expect(runs).toEqual([['rm', '--', CLAUDE]])
    expect(fs.has(CLAUDE)).toBe(false)
    expect(fs.get(JOURNAL)).toContain('remove-file')
  })

  test('une unité disparue (fichier changé) ne modifie rien', async () => {
    const { io, fs } = fakeIo({ [CLAUDE]: '- a\n' })
    const res = await runDisable(io, env, unitItem('hdeadbeef-0'))
    expect(res.ok).toBe(false)
    expect(fs.get(CLAUDE)).toBe('- a\n')
    expect(fs.has(JOURNAL)).toBe(false)
  })

  test('hors périmètre : refus sans écriture', async () => {
    const path = `${HOME}/.claude/plugins/cache/hcc/CLAUDE.md`
    const { io, fs } = fakeIo({ [path]: '- a\n' })
    const item: Item = { ...unitItem('x'), source: { kind: 'file', path, tier: 'project' }, disable: { kind: 'remove-unit', path, unitId: 'x' } }
    const res = await runDisable(io, env, item)
    expect(res.ok).toBe(false)
    expect(res.notice).toContain('Hors périmètre')
    expect(fs.has(JOURNAL)).toBe(false)
  })
})

describe('runDisable : mémoire', () => {
  test('supprimer une note retire aussi sa ligne dans MEMORY.md', async () => {
    const dir = `${HOME}/.claude/projects/-p/memory`
    const index = `${dir}/MEMORY.md`
    const note = `${dir}/note-a.md`
    const { io, fs, runs } = fakeIo({ [index]: '- [A](note-a.md) — a\n- [B](note-b.md) — b\n', [note]: '---\nname: a\n---\n\nA.\n' })
    const item: Item = { id: 'memory/x', group: 'memory', title: 'A', text: '', tokens: 0, vanilla: false, source: { kind: 'file', path: note, tier: 'memory' }, disable: { kind: 'remove-file', path: note, indexPath: index } }
    const res = await runDisable(io, env, item)
    expect(res.ok).toBe(true)
    expect(runs[0]).toEqual(['rm', '--', note])
    expect(fs.get(index)).toBe('- [B](note-b.md) — b\n')
    expect(res.invalidate).toEqual(['prompt.section'])
  })

  test('la dernière ligne d’index retirée supprime MEMORY.md', async () => {
    const dir = `${HOME}/.claude/projects/-p/memory`
    const index = `${dir}/MEMORY.md`
    const note = `${dir}/note-a.md`
    const { io, fs } = fakeIo({ [index]: '- [A](note-a.md) — a\n', [note]: 'A.\n' })
    const item: Item = { id: 'memory/x', group: 'memory', title: 'A', text: '', tokens: 0, vanilla: false, source: { kind: 'file', path: note, tier: 'memory' }, disable: { kind: 'remove-file', path: note, indexPath: index } }
    await runDisable(io, env, item)
    expect(fs.has(index)).toBe(false)
    expect(fs.has(note)).toBe(false)
  })
})

describe('runDisable : settings', () => {
  const SETTINGS = `${HOME}/.claude/settings.json`
  const base = { outputStyle: 'Concise', model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] }, enabledPlugins: { 'hcc@hcc': true } }
  const json = () => `${JSON.stringify(base, null, 2)}\n`

  test('retire une clé et laisse les autres intactes', async () => {
    const { io, fs } = fakeIo({ [SETTINGS]: json() })
    const item: Item = { id: 's', group: 'settings', title: 'outputStyle', text: '"Concise"', tokens: 0, vanilla: false, source: { kind: 'settings', path: SETTINGS, keyPath: ['outputStyle'] }, disable: { kind: 'remove-key', path: SETTINGS, keyPath: ['outputStyle'] } }
    const res = await runDisable(io, env, item)
    expect(res.ok).toBe(true)
    const after = JSON.parse(fs.get(SETTINGS)!)
    expect(after.outputStyle).toBeUndefined()
    expect(after.model).toBe('opus')
    expect(fs.get(SETTINGS)!.endsWith('\n')).toBe(true)
    expect(res.invalidate).toEqual([])
  })

  test('retirer le dernier hook d’un événement retire l’événement puis la clé hooks', async () => {
    const { io, fs } = fakeIo({ [SETTINGS]: json() })
    const item: Item = { id: 'h', group: 'hooks', title: 'Stop', text: '', tokens: 0, vanilla: false, source: { kind: 'settings', path: SETTINGS, keyPath: ['hooks', 'Stop', 0] }, disable: { kind: 'remove-hook', path: SETTINGS, keyPath: ['hooks', 'Stop', 0] } }
    const res = await runDisable(io, env, item)
    expect(res.ok).toBe(true)
    expect(JSON.parse(fs.get(SETTINGS)!).hooks).toBeUndefined()
  })

  test('désactiver un plugin écrit enabledPlugins à false', async () => {
    const { io, fs } = fakeIo({ [SETTINGS]: json() })
    const item: Item = { id: 'p', group: 'plugins', title: 'hcc', text: '', tokens: 0, vanilla: false, source: { kind: 'plugin', name: 'hcc' }, disable: { kind: 'disable-plugin', path: SETTINGS, plugin: 'hcc@hcc' } }
    const res = await runDisable(io, env, item)
    expect(res.ok).toBe(true)
    expect(JSON.parse(fs.get(SETTINGS)!).enabledPlugins['hcc@hcc']).toBe(false)
  })

  test('un settings.json corrompu donne un message et n’écrit rien', async () => {
    const { io, fs } = fakeIo({ [SETTINGS]: '{ pas du json' })
    const item: Item = { id: 's', group: 'settings', title: 'model', text: '', tokens: 0, vanilla: false, source: { kind: 'settings', path: SETTINGS, keyPath: ['model'] }, disable: { kind: 'remove-key', path: SETTINGS, keyPath: ['model'] } }
    const res = await runDisable(io, env, item)
    expect(res.ok).toBe(false)
    expect(res.notice).toContain('JSON illisible')
    expect(fs.get(SETTINGS)).toBe('{ pas du json')
  })
})

describe('runDisable : skills', () => {
  test('déplace le dossier vers skills.disabled', async () => {
    const dir = `${HOME}/.claude/skills/grilling`
    const { io, fs, runs } = fakeIo({ [`${dir}/SKILL.md`]: '# g\n' })
    const item: Item = { id: 'k', group: 'skills', title: '/grilling', text: '', tokens: 0, vanilla: false, source: { kind: 'file', path: `${dir}/SKILL.md`, tier: 'skill' }, disable: { kind: 'disable-skill', path: dir } }
    const res = await runDisable(io, env, item)
    expect(res.ok).toBe(true)
    expect(runs).toEqual([['mkdir', '-p', `${HOME}/.claude/skills.disabled`], ['mv', '--', dir, `${HOME}/.claude/skills.disabled/grilling`]])
    expect(fs.has(`${HOME}/.claude/skills.disabled/grilling/SKILL.md`)).toBe(true)
  })
})

describe('édition', () => {
  test('mono-ligne : remplace la puce en place', async () => {
    const { io, fs } = fakeIo({ [CLAUDE]: '- un\n- deux\n' })
    const u = parseUnits(fs.get(CLAUDE)!).units[1]!
    const res = await runInlineEdit(io, env, unitItem(u.id, 'deux'), 'trois')
    expect(res.ok).toBe(true)
    expect(fs.get(CLAUDE)).toBe('- un\n- trois\n')
    expect(fs.get(JOURNAL)).toContain('edit-unit')
  })

  test('clé settings scalaire : écrit la nouvelle valeur', async () => {
    const SETTINGS = `${HOME}/.claude/settings.json`
    const { io, fs } = fakeIo({ [SETTINGS]: '{\n  "model": "opus"\n}\n' })
    const item: Item = { id: 's', group: 'settings', title: 'model', text: '"opus"', tokens: 0, vanilla: false, source: { kind: 'settings', path: SETTINGS, keyPath: ['model'] }, edit: 'inline' }
    const res = await runInlineEdit(io, env, item, 'sonnet')
    expect(res.ok).toBe(true)
    expect(JSON.parse(fs.get(SETTINGS)!).model).toBe('sonnet')
  })

  test('via le composer : remplace un composer vide, ajoute à un composer plein, ne soumet jamais', async () => {
    const vide = fakeIo({}, '')
    const r1 = await fillPromptForEdit(vide.io, unitItem('x', 'Locale française.'))
    expect(r1.ok).toBe(true)
    expect(vide.fills).toEqual([{ text: `Modifie dans \`${CLAUDE}\` le bloc « Locale française. » : `, mode: 'replace' }])
    const plein = fakeIo({}, 'déjà du texte')
    await fillPromptForEdit(plein.io, unitItem('x', 'Locale française.'))
    expect(plein.fills[0]?.mode).toBe('append')
    expect(plein.fills[0]?.text.startsWith('\n')).toBe(true)
  })
})
