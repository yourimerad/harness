import { describe, expect, test } from 'claude-code/testing'

import type { HarnessItem as Item, HarnessSnapshot as Snapshot } from '../types'
import { buildInventory, discoverPlugins, journalTail } from '../hooks/lib/inventory'
import { viewFromArg } from '../hooks/pane'
import { estimateTokens } from '../hooks/lib/tokens'
import { BREAKDOWN, CWD, DIRS, FILES, HCC, HOME, MEM, SNAP, env, io } from './fixtures'

const leaves = (items: Item[]): Item[] => items.flatMap(i => (i.children?.length ? leaves(i.children) : [i]))
const group = (inv: Awaited<ReturnType<typeof buildInventory>>, id: string) => inv.groups.find(g => g.id === id)!

describe('discoverPlugins', () => {
  test('voit un plugin installé avec son dossier et son activation', async () => {
    const r = { text: async (p: string) => FILES[p] ?? null, json: async (p: string) => (FILES[p] ? JSON.parse(FILES[p]!) : null), list: async (p: string) => DIRS[p] ?? [], exists: async (p: string) => p in FILES, watched: new Set<string>() }
    const found = await discoverPlugins(r, io(), env)
    expect(found.map(p => p.name)).toEqual(['hcc'])
    expect(found[0]).toMatchObject({ provenance: 'installed', root: HCC, enabled: true, marketplace: 'hcc' })
    expect(found[0]!.installPath).toBeUndefined()
  })

  test('marketplace locale (directory) : le dossier lu est la source déclarée, la copie de plugins/cache est signalée', async () => {
    const files: Record<string, string> = {
      ...FILES,
      [`${HOME}/.claude/plugins/known_marketplaces.json`]: JSON.stringify({ hcc: { source: { source: 'directory', path: `${HOME}/hcc` }, installLocation: `${HOME}/hcc` } }),
      [`${HOME}/hcc/.claude-plugin/marketplace.json`]: JSON.stringify({ name: 'hcc', plugins: [{ name: 'hcc', source: './' }] }),
      [`${HOME}/hcc/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'hcc', version: '0.2.3', description: 'dox (source)' }),
    }
    const r = { text: async (p: string) => files[p] ?? null, json: async (p: string) => (files[p] ? JSON.parse(files[p]!) : null), list: async (p: string) => DIRS[p] ?? [], exists: async (p: string) => p in files, watched: new Set<string>() }
    const found = await discoverPlugins(r, io(files), env)
    expect(found[0]).toMatchObject({ root: `${HOME}/hcc`, installPath: HCC, description: 'dox (source)' })
    const inv = await buildInventory(io(files), SNAP, env)
    const item = group(inv, 'plugins').children!.find(i => i.id === 'plugins/hcc')!
    expect(item.badges).toContain('lu depuis son dossier')
    expect(item.text).toContain(`Dossier : ${HOME}/hcc`)
    expect(item.text).toContain(`Copie d'installation (non lue) : ${HCC}`)
  })

  test('marketplace distante : pas de known_marketplaces directory → la copie installée reste le dossier', async () => {
    const files: Record<string, string> = {
      ...FILES,
      [`${HOME}/.claude/plugins/known_marketplaces.json`]: JSON.stringify({ hcc: { source: { source: 'github', repo: 'y/hcc' }, installLocation: `${HOME}/.claude/plugins/marketplaces/hcc` } }),
    }
    const r = { text: async (p: string) => files[p] ?? null, json: async (p: string) => (files[p] ? JSON.parse(files[p]!) : null), list: async (p: string) => DIRS[p] ?? [], exists: async (p: string) => p in files, watched: new Set<string>() }
    const found = await discoverPlugins(r, io(files), env)
    expect(found[0]).toMatchObject({ root: HCC })
    expect(found[0]!.installPath).toBeUndefined()
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

  test('l’index mémoire observé (kind memory) est compté une fois, dans Mémoire, avec le badge observé', async () => {
    const snap: Snapshot = { ...SNAP, instructionFiles: [
      { path: `${HOME}/.claude/CLAUDE.md`, kind: 'user', content: FILES[`${HOME}/.claude/CLAUDE.md`]! },
      { path: `${MEM}/MEMORY.md`, kind: 'memory', content: FILES[`${MEM}/MEMORY.md`]! },
    ] }
    const inv = await buildInventory(io(), snap, env)
    expect(group(inv, 'claudeMd').children!.map(f => f.id)).toEqual([`claudeMd/${HOME}/.claude/CLAUDE.md`])
    const index = group(inv, 'memory').children!.find(i => i.title === 'MEMORY.md (index)')!
    expect(index.badges).toContain('observé')
    expect(leaves(inv.groups.filter(g => g.id !== 'surface')).filter(i => i.source.kind === 'file' && i.source.path === `${MEM}/MEMORY.md`)).toHaveLength(1)
  })

  test('index mémoire observé hors du dossier déduit : son dossier fait foi, son contenu sert si le disque manque', async () => {
    const other = `${HOME}/.claude/projects/-Users-y-autre/memory`
    const snap: Snapshot = { ...SNAP, instructionFiles: [{ path: `${other}/MEMORY.md`, kind: 'memory', content: '- [Note](n.md) — x\n' }] }
    const inv = await buildInventory(io(), snap, env)
    const index = group(inv, 'memory').children!.find(i => i.title === 'MEMORY.md (index)')!
    expect(index.source).toEqual({ kind: 'file', path: `${other}/MEMORY.md`, tier: 'memory' })
    expect(index.children![0]!.disable).toMatchObject({ kind: 'remove-file', path: `${other}/n.md`, indexPath: `${other}/MEMORY.md` })
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

// Sous le preset SDK (app de bureau), le style de sortie, les instructions MCP et le cadre mémoire ne sont pas
// des sections : ils voyagent dans le premier message ou en reminder, parfois plusieurs sujets dans un même texte.
describe('buildInventory : marqueurs hors sections (preset SDK)', () => {
  const noSections: Snapshot = { ...SNAP, outputStyle: null, sections: [{ id: 'lean_body', text: 'You are Claude Code.', scope: 'shared' }] }
  const composite = [
    '# Environment', 'You have been invoked in the following environment:', ' - Primary working directory: /Users/y/proj', '',
    '# Output Style: Concise', 'Keep it short.', '', '# Concise Style Active', 'Lead with the result.', '',
    'Available agent types for the Agent tool:', '- Explore: lit', '',
    '# MCP Server Instructions', '', 'The following MCP servers have provided instructions:', '', '## claude-in-chrome', 'Load the tools first.', '',
    '## plugin:small-business:gmail', 'Gmail API.', '', 'The following skills are available:', '- /grilling',
  ].join('\n')

  test('style de sortie et instructions MCP lus dans un bloc composite ; le reste du bloc reste au moteur', async () => {
    const snap: Snapshot = { ...noSections, blocks: [{ name: 'sdkPreset', text: composite }] }
    const inv = await buildInventory(io(), snap, env)
    const style = group(inv, 'settings').children!.find(i => i.id === 'settings/section/block:sdkPreset')!
    expect(style.title).toBe('Output style « Concise » (bloc sdkPreset)')
    expect(style.text).toContain('# Concise Style Active')
    expect(style.text).not.toContain('Available agent types')
    expect(style.disable).toEqual({ kind: 'remove-key', path: `${HOME}/.claude/settings.json`, keyPath: ['outputStyle'] })
    const mcp = group(inv, 'mcp').children!
    expect(mcp.map(i => i.title)).toEqual(['Cadre MCP (moteur)', 'claude-in-chrome', 'plugin:small-business:gmail', 'vercel'])
    expect(mcp[2]!.hint).toContain('plugin small-business')
    const block = group(inv, 'engine').children!.find(i => i.id === 'engine/block/sdkPreset')!
    expect(block.text).toContain('# Environment')
    expect(block.text).toContain('Available agent types')
    expect(block.text).not.toContain('# Output Style')
    expect(block.text).not.toContain('## claude-in-chrome')
  })

  test('les mêmes marqueurs dans un reminder : un item par serveur, sans doublon, le reminder reste hors des groupes', async () => {
    const later = '# MCP Server Instructions\n\n## plugin:small-business:gmail\nGmail API, encore.\n\n## plugin:small-business:shopify\nShopify.'
    const snap: Snapshot = { ...noSections, blocks: [{ name: 'sdkPreset', text: composite }], attachments: [{ type: 'deferred_tools_delta', text: later, origin: 'engine' }] }
    const inv = await buildInventory(io(), snap, env)
    const mcp = group(inv, 'mcp').children!
    expect(mcp.map(i => i.title)).toEqual(['Cadre MCP (moteur)', 'claude-in-chrome', 'plugin:small-business:gmail', 'plugin:small-business:shopify', 'vercel'])
    expect(mcp.find(i => i.title === 'plugin:small-business:gmail')!.text).toBe('Gmail API.')
    expect(mcp.find(i => i.title === 'plugin:small-business:shopify')!.badges).toContain('reminder deferred_tools_delta')
    expect(leaves(inv.groups).some(i => i.id.includes('deferred_tools_delta') && i.group !== 'mcp' && i.group !== 'settings')).toBe(false)
  })

  test('style de sortie en reminder seul, sans `outputStyle` composé : le nom vient du titre', async () => {
    const snap: Snapshot = { ...noSections, attachments: [{ type: 'instructions', text: '# Output Style: Bref\nCourt.', origin: 'engine' }] }
    const inv = await buildInventory(io(), snap, env)
    const style = group(inv, 'settings').children!.find(i => i.id.startsWith('settings/section/'))!
    expect(style.title).toBe('Output style « Bref » (reminder instructions)')
    expect(style.badges).toContain('prompt.attachment')
  })

  test('cadre mémoire dans un bloc : le dossier mémoire en est lu', async () => {
    const snap: Snapshot = { ...noSections, blocks: [{ name: 'sdkPreset', text: `# Memory\n\nYou have a persistent file-based memory at \`${MEM}/\`.\n\n# Environment\nx` }] }
    const inv = await buildInventory(io(), snap, env)
    const mem = group(inv, 'memory').children!
    expect(mem[0]!.title).toBe('Cadre mémoire (moteur)')
    expect(mem[0]!.text).not.toContain('# Environment')
    expect(mem.some(i => i.title === 'MEMORY.md (index)')).toBe(true)
  })

  test('un serveur épelé comme dans les noms d’outils rejoint l’item de ses instructions', async () => {
    const snap: Snapshot = { ...noSections, blocks: [{ name: 'sdkPreset', text: composite }] }
    const tools = async () => [{ name: 'mcp__plugin_small-business_gmail__get_message', description: 'Lit', mcp: true }]
    const inv = await buildInventory({ ...io(), tools }, snap, env)
    const mcp = group(inv, 'mcp').children!
    expect(mcp.filter(i => i.title.includes('gmail'))).toHaveLength(1)
    expect(group(inv, 'surface').children!.some(i => i.id === 'surface/tools/mcp:plugin_small-business_gmail')).toBe(true)
  })
})

// La ventilation /context (`$.session.usage({ breakdown: 'summary' })`) : les mesures du moteur priment sur les estimations.
describe('buildInventory : mesure /context', () => {
  const measured = () => buildInventory(io(FILES, DIRS, async () => BREAKDOWN), SNAP, env)

  test('outils MCP : chargés comptés au schéma, différés au nom, nom /mcp affiché ; outils du moteur à la catégorie', async () => {
    const inv = await measured()
    const surface = group(inv, 'surface').children!
    const vercel = surface.find(i => i.id === 'surface/tools/mcp:vercel')!
    expect(vercel.title).toBe('outils MCP Vercel (vercel) : 2')
    expect(vercel.tokens).toBe(300 + estimateTokens('mcp__vercel__get_project'))
    expect(vercel.badges).toEqual(['1 chargés en entier', '1 différés (noms seuls)', 'mesuré par /context'])
    // mesuré par /context mais absent de tool.list (connecté après la liste) : compté quand même
    const gmail = surface.find(i => i.id === 'surface/tools/mcp:claude_ai_Gmail')!
    expect(gmail.tokens).toBe(250)
    expect(group(inv, 'mcp').children!.some(i => i.id === 'mcp/claude_ai_Gmail')).toBe(true)
    expect(surface.find(i => i.id === 'surface/tools/engine')!.tokens).toBe(1500)
  })

  test('skills : le listing mesuré fait foi, un skill hors budget pèse 0', async () => {
    const inv = await measured()
    const skills = group(inv, 'skills').children!
    expect(skills.find(s => s.title === '/grilling')!.tokens).toBe(50)
    expect(skills.find(s => s.title === '/hcc:dox-pass')!.tokens).toBe(40)
    const pdf = skills.find(s => s.title === '/anthropic-skills:pdf')!
    expect(pdf.tokens).toBe(0)
    expect(pdf.badges).toContain('hors du listing envoyé au modèle (budget) : 0 tok')
  })

  test('agents : plugin local → couper le plugin ; claude.ai → pointeur ; perso → fichier hors périmètre', async () => {
    const inv = await measured()
    const skills = group(inv, 'skills').children!
    const dox = skills.find(s => s.id === 'skills/agent/hcc:dox-updater')!
    expect(dox.disable).toEqual({ kind: 'disable-plugin', path: `${HOME}/.claude/settings.json`, plugin: 'hcc@hcc' })
    expect(dox.tokens).toBe(40)
    const seo = skills.find(s => s.id === 'skills/agent/seo:auditor')!
    expect(seo.source).toEqual({ kind: 'claude-ai', what: 'plugin seo' })
    expect(seo.disable).toBeUndefined()
    const reviewer = skills.find(s => s.id === 'skills/agent/reviewer')!
    expect(reviewer.source).toEqual({ kind: 'file', path: `${HOME}/.claude/agents/reviewer.md`, tier: 'agent' })
    expect(reviewer.disable).toBeUndefined()
    expect(reviewer.hint).toContain('hors du périmètre')
    expect(inv.count).toBe(leaves(inv.groups.filter(g => g.id !== 'surface')).filter(i => !i.vanilla).length)
  })

  test('CLAUDE.md reconstruit : /context dit ce qui est chargé, le reste est sur disque ; un fichier hors chaîne est ajouté', async () => {
    const files = { ...FILES, [`${HOME}/.claude/rules/extra.md`]: '- règle extra\n', [`${CWD}/CLAUDE.md`]: '- projet\n' }
    const inv = await buildInventory(io(files, DIRS, async () => BREAKDOWN), SNAP, env)
    const claude = group(inv, 'claudeMd').children!
    const byPath = (p: string) => claude.find(f => f.source.kind === 'file' && f.source.path === p)!
    expect(byPath(`${HOME}/.claude/CLAUDE.md`).badges).toContain('chargé (mesuré par /context)')
    expect(byPath(`${CWD}/CLAUDE.md`).badges).toContain('sur disque, non chargé dans cette session')
    expect(byPath(`${HOME}/.claude/rules/extra.md`).badges).toContain('chargé hors de la chaîne connue')
    expect(claude.some(f => f.source.kind === 'file' && f.source.path.endsWith('/MEMORY.md'))).toBe(false)
  })

  test('system prompt : la part mesurée au-delà des sections est signalée dans le groupe App, vanilla', async () => {
    const inv = await measured()
    const rest = group(inv, 'app').children!.find(i => i.id === 'app/system-prompt-rest')!
    expect(rest.vanilla).toBe(true)
    const sections = SNAP.sections.reduce((n, s) => n + estimateTokens(s.text), 0)
    expect(rest.tokens).toBe(9000 - sections)
    expect(rest.badges).toContain('non observable par un hook')
  })

  test('mesure proche des sections : pas d’item App (l’écart d’estimateur ne compte pas)', async () => {
    const sections = SNAP.sections.reduce((n, s) => n + estimateTokens(s.text), 0)
    const close = { ...BREAKDOWN, categories: [{ name: 'System prompt', tokens: Math.round(sections * 1.2), kind: 'used' as const }] }
    const inv = await buildInventory(io(FILES, DIRS, async () => close), SNAP, env)
    expect(group(inv, 'app').children!.some(i => i.id === 'app/system-prompt-rest')).toBe(false)
  })

  test('sans mesure, rien ne change : estimations comme avant, ni agents ni item App', async () => {
    const inv = await buildInventory(io(), SNAP, env)
    expect(group(inv, 'app').children!.some(i => i.id === 'app/system-prompt-rest')).toBe(false)
    expect(group(inv, 'skills').children!.some(i => i.id.startsWith('skills/agent/'))).toBe(false)
    expect(group(inv, 'surface').children!.find(i => i.id === 'surface/tools/mcp:vercel')!.badges).toEqual(['différés (noms seuls)'])
  })
})

describe('journal', () => {
  const entry = (n: number) => `## 2026-10-19T10:0${n}:00.000Z · remove-unit · /x\n\n**Avant**\n\n\`\`\`\n- puce ${n}\n\`\`\`\n`
  const text = `# Journal harness\n\nintro.\n\n${entry(1)}\n${entry(2)}\n${entry(3)}`

  test('journalTail : court → entier ; long → coupé au début d’une entrée, l’en-tête sauté', () => {
    expect(journalTail(text, 10_000)).toBe(text)
    const tail = journalTail(text, entry(3).length + entry(2).length + 10)
    expect(tail.startsWith('## 2026-10-19T10:02')).toBe(true)
    expect(tail).toContain('puce 3')
    expect(tail).not.toContain('intro.')
  })

  test('l’inventaire porte la fin du journal, surveillée ; null sans journal', async () => {
    const files = { ...FILES, [`${HOME}/.claude/harness/journal.md`]: text }
    const inv = await buildInventory(io(files), SNAP, env)
    expect(inv.journal).toBe(text)
    expect(inv.watched).toContain(`${HOME}/.claude/harness/journal.md`)
    expect((await buildInventory(io(), SNAP, env)).journal).toBeNull()
  })
})

describe('vues du pane', () => {
  test('viewFromArg : id, touche, libellé abrégé sans accent ; vide ou inconnu → null', () => {
    expect(viewFromArg('journal')).toBe('journal')
    expect(viewFromArg(' 3 ')).toBe('config')
    expect(viewFromArg('Régl')).toBe('config')
    expect(viewFromArg('regl')).toBe('config')
    expect(viewFromArg('mcp')).toBe('mcp')
    expect(viewFromArg('')).toBeNull()
    expect(viewFromArg('zzz')).toBeNull()
  })
})
