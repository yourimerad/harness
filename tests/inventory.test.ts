import { describe, expect, test } from 'claude-code/testing'

import type { HarnessItem as Item, HarnessSnapshot as Snapshot } from '../types'
import { buildInventory, discoverPlugins } from '../hooks/lib/inventory'
import { CWD, DIRS, FILES, HCC, HOME, MEM, SNAP, env, io } from './fixtures'

const leaves = (items: Item[]): Item[] => items.flatMap(i => (i.children?.length ? leaves(i.children) : [i]))
const group = (inv: Awaited<ReturnType<typeof buildInventory>>, id: string) => inv.groups.find(g => g.id === id)!

describe('discoverPlugins', () => {
  test('voit un plugin installé avec son dossier et son activation', async () => {
    const r = { text: async (p: string) => FILES[p] ?? null, json: async (p: string) => (FILES[p] ? JSON.parse(FILES[p]!) : null), list: async (p: string) => DIRS[p] ?? [], exists: async (p: string) => p in FILES, watched: new Set<string>() }
    const found = await discoverPlugins(r, io(), env)
    expect(found.map(p => p.name)).toEqual(['hcc'])
    expect(found[0]).toMatchObject({ provenance: 'installed', root: HCC, enabled: true, marketplace: 'hcc' })
  })
})

describe('buildInventory', () => {
  test('les groupes sont dans l’ordre de réception', async () => {
    const inv = await buildInventory(io(), SNAP, env)
    expect(inv.groups.map(g => g.id)).toEqual(['engine', 'app', 'claudeMd', 'memory', 'settings', 'hooks', 'plugins', 'skills', 'mcp', 'surface'])
  })

  test('sections : id nu → moteur, plugin intégré → app, plugin utilisateur → plugins', async () => {
    const inv = await buildInventory(io(), SNAP, env)
    expect(group(inv, 'engine').children!.map(i => i.title)).toContain('intro')
    expect(group(inv, 'engine').children!.every(i => i.vanilla)).toBe(true)
    expect(group(inv, 'app').children!.some(i => i.title === 'ccd:tasks' && i.vanilla)).toBe(true)
    const hcc = group(inv, 'plugins').children!.find(i => i.id === 'plugins/hcc')!
    expect(hcc.children!.some(c => c.title === 'hcc:policy' && !c.vanilla)).toBe(true)
  })

  test('la section Output Style est rattachée à settings.outputStyle, désactivable', async () => {
    const inv = await buildInventory(io(), SNAP, env)
    const style = group(inv, 'settings').children!.find(i => i.id.startsWith('settings/section/'))!
    expect(style.vanilla).toBe(false)
    expect(style.disable).toEqual({ kind: 'remove-key', path: `${HOME}/.claude/settings.json`, keyPath: ['outputStyle'] })
  })

  test('CLAUDE.md reconstruit depuis le disque : un fichier, trois unités, badges', async () => {
    const inv = await buildInventory(io(), SNAP, env)
    expect(inv.observedClaudeMd).toBe(false)
    const files = group(inv, 'claudeMd').children!
    expect(files).toHaveLength(1)
    expect(files[0]!.badges).toContain('reconstruit')
    expect(files[0]!.children!.map(u => u.title)).toEqual(['Locale française.', 'Secrets via `$VAR`.', 'Stack TypeScript.'])
    expect(files[0]!.children![0]!.edit).toBe('inline')
    expect(files[0]!.children![0]!.disable?.kind).toBe('remove-unit')
    expect(files[0]!.disable?.kind).toBe('remove-file')
  })

  test('CLAUDE.md observé : la liste vient de prompt.context, pas du disque', async () => {
    const snap: Snapshot = { ...SNAP, instructionFiles: [{ path: `${CWD}/CLAUDE.md`, kind: 'project', content: '- règle projet\n' }] }
    const inv = await buildInventory(io(), snap, env)
    expect(inv.observedClaudeMd).toBe(true)
    const files = group(inv, 'claudeMd').children!
    // l'observé d'abord, puis ce que le disque porte et que le moteur n'a pas chargé dans cette session
    expect(files.map(f => (f.source.kind === 'file' ? f.source.path : ''))).toEqual([`${CWD}/CLAUDE.md`, `${HOME}/.claude/CLAUDE.md`])
    expect(files[0]!.badges).toContain('observé')
    expect(files[0]!.children![0]!.title).toBe('règle projet')
    expect(files[1]!.badges).toContain('sur disque, non chargé dans cette session')
  })

  test('CLAUDE.md observé dont le disque a changé : badge de relecture', async () => {
    const snap: Snapshot = { ...SNAP, instructionFiles: [{ path: `${HOME}/.claude/CLAUDE.md`, kind: 'user', content: '# Contexte\n\n## Machine\n- Locale française.\n' }] }
    const inv = await buildInventory(io(), snap, env)
    const file = group(inv, 'claudeMd').children![0]!
    expect(file.badges!.some(b => b.startsWith('disque ≠ contexte'))).toBe(true)
    // les unités viennent du disque (3), pas du contexte (1)
    expect(file.children).toHaveLength(3)
  })

  test('mémoire : le dossier vient de la section, les notes pointent leur ligne d’index', async () => {
    const inv = await buildInventory(io(), SNAP, env)
    const mem = group(inv, 'memory').children!
    expect(mem[0]!.title).toBe('Cadre mémoire (moteur)')
    const index = mem.find(i => i.title === 'MEMORY.md (index)')!
    expect(index.children![0]!.disable).toMatchObject({ kind: 'remove-file', path: `${MEM}/pin.md`, indexPath: `${MEM}/MEMORY.md` })
    const orpheline = mem.find(i => i.title.endsWith('orpheline.md'))!
    expect(orpheline.badges).toContain('non indexée')
    expect(orpheline.tokens).toBe(0)
  })

  test('settings : clés de comportement d’abord, hooks sortis vers le groupe Hooks', async () => {
    const inv = await buildInventory(io(), SNAP, env)
    const keys = group(inv, 'settings').children!.filter(i => !i.id.startsWith('settings/section/')).map(i => i.title)
    expect(keys.slice(0, 3)).toEqual(['outputStyle', 'model', 'effortLevel'])
    expect(keys).not.toContain('hooks')
    expect(keys).toContain('theme')
    const model = group(inv, 'settings').children!.find(i => i.title === 'model')!
    expect(model.edit).toBe('inline')
    expect(model.tokens).toBe(0)
  })

  test('hooks : entrée settings retirable, hooks de plugin coupés par le plugin entier', async () => {
    const inv = await buildInventory(io(), SNAP, env)
    const hooks = group(inv, 'hooks').children!
    const stop = hooks.find(h => h.id === 'hooks/settings/user/Stop/0')!
    expect(stop.disable).toEqual({ kind: 'remove-hook', path: `${HOME}/.claude/settings.json`, keyPath: ['hooks', 'Stop', 0] })
    const pre = hooks.find(h => h.id === 'hooks/plugin/hcc/PreToolUse/0')!
    expect(pre.title).toContain('[Edit|Write]')
    expect(pre.disable).toEqual({ kind: 'disable-plugin', path: `${HOME}/.claude/settings.json`, plugin: 'hcc@hcc' })
    expect(pre.hint).toContain('plugin entier')
  })

  test('plugins : hcc avec ses contenus comptés', async () => {
    const inv = await buildInventory(io(), SNAP, env)
    const hcc = group(inv, 'plugins').children!.find(i => i.id === 'plugins/hcc')!
    expect(hcc.title).toBe('hcc 0.2.2')
    expect(hcc.children!.some(c => c.title === '2 skills · 1 agents')).toBe(true)
    expect(hcc.disable?.kind).toBe('disable-plugin')
  })

  test('skills : perso → déplacement, plugin local → plugin, claude.ai → pointeur, intégré → app', async () => {
    const inv = await buildInventory(io(), SNAP, env)
    const skills = group(inv, 'skills').children!
    const grilling = skills.find(s => s.title === '/grilling')!
    expect(grilling.disable).toEqual({ kind: 'disable-skill', path: `${HOME}/.claude/skills/grilling` })
    expect(grilling.text).toContain('Grille.')
    const dox = skills.find(s => s.title === '/hcc:dox-pass')!
    expect(dox.disable?.kind).toBe('disable-plugin')
    const pdf = skills.find(s => s.title === '/anthropic-skills:pdf')!
    expect(pdf.disable).toBeUndefined()
    expect(pdf.source).toEqual({ kind: 'claude-ai', what: 'plugin anthropic-skills' })
    expect(skills.some(s => s.title === '/ccd:tasks')).toBe(false)
    expect(group(inv, 'app').children!.some(i => i.title === 'plugin intégré ccd')).toBe(true)
  })

  test('MCP : un item par serveur avec le bon pointeur', async () => {
    const inv = await buildInventory(io(), SNAP, env)
    const mcp = group(inv, 'mcp').children!
    expect(mcp[0]!.title).toBe('Cadre MCP (moteur)')
    expect(mcp.find(i => i.title === 'vercel')!.hint).toContain('claude.ai')
    expect(mcp.find(i => i.title === 'multi-gmail')!.hint).toContain('mcpServers')
  })

  test('surface : outils du moteur vanilla décrits, outils MCP différés et non-vanilla', async () => {
    const inv = await buildInventory(io(), SNAP, env)
    const surface = group(inv, 'surface').children!
    const engine = surface.find(i => i.id === 'surface/tools/engine')!
    const vercel = surface.find(i => i.id === 'surface/tools/mcp:vercel')!
    expect(engine.vanilla).toBe(true)
    expect(vercel.vanilla).toBe(false)
    expect(vercel.title).toBe('outils MCP vercel : 2')
    expect(surface.find(i => i.id === 'surface/commands/builtin')!.vanilla).toBe(true)
  })

  test('comptes : N = feuilles non-vanilla hors surface ; tokens incluent la surface non-vanilla', async () => {
    const inv = await buildInventory(io(), SNAP, env)
    const expected = leaves(inv.groups.filter(g => g.id !== 'surface')).filter(i => !i.vanilla).length
    expect(inv.count).toBe(expected)
    const surfaceTok = group(inv, 'surface').children!.filter(i => !i.vanilla).reduce((n, i) => n + i.tokens, 0)
    expect(inv.tokens).toBeGreaterThanOrEqual(surfaceTok)
    expect(inv.watched).toContain(`${HOME}/.claude/CLAUDE.md`)
    expect(inv.watched).toContain(`${HOME}/.claude/settings.json`)
  })

  test('sans snapshot ni fichiers : des groupes vides, pas d’erreur', async () => {
    const inv = await buildInventory(io({}, {}), null, env)
    expect(inv.count).toBeGreaterThanOrEqual(0)
    expect(group(inv, 'claudeMd').children).toEqual([])
  })
})
