// Construit l'inventaire : un arbre d'items par groupe, à partir de la capture
// (snapshot) et d'une lecture du disque. Pur côté logique ; les lectures passent par un objet io.
import type {
  HarnessDisable as Disable,
  HarnessInventory as Inventory,
  HarnessItem as Item,
  HarnessSnapshot as Snapshot,
  HarnessSource as Source,
} from '../../types'
import { memoryDirFor, sectionSource, toolProvider } from './classify'
import { parseUnits } from './markdown'
import { estimateTokens } from './tokens'

export type Env = { home: string; cwd: string; root: string; now: string }

/** Les entrées-sorties dont l'inventaire a besoin ; construites dans le module de hooks autour de `$`. */
export type InventoryIo = {
  readText: (path: string) => Promise<string | null>
  list: (path: string) => Promise<string[]>
  exists: (path: string) => Promise<boolean>
  pluginDirs: () => Promise<string | undefined>
  ancestors: (names: string[]) => Promise<readonly { dir: string; name: string; parts: readonly { path: string; content: string }[] }[]>
  commands: () => Promise<readonly { name: string; description: string; source: string; plugin?: string }[]>
  tools: () => Promise<readonly { name: string; description: string; mcp: boolean }[]>
}

export type PluginInfo = {
  name: string
  version?: string
  description?: string
  root?: string
  provenance: 'installed' | 'synced' | 'dev' | 'inline'
  marketplace?: string
  enabled: boolean
}

type Reader = {
  text: (path: string) => Promise<string | null>
  json: (path: string) => Promise<unknown>
  list: (path: string) => Promise<string[]>
  exists: (path: string) => Promise<boolean>
  watched: Set<string>
}

const BEHAVIOURAL_KEYS = [
  'outputStyle', 'model', 'effortLevel', 'modelSettings', 'permissions', 'env', 'enabledPlugins',
  'extraKnownMarketplaces', 'disableBundledSkills', 'statusLine', 'worktree', 'pluginConfigs',
]

const makeReader = (io: InventoryIo): Reader => {
  const watched = new Set<string>()
  const text = async (path: string) => {
    const out = await io.readText(path)
    if (out !== null) watched.add(path)
    return out
  }
  return {
    watched,
    text,
    json: async path => {
      const raw = await text(path)
      if (raw === null) return null
      try {
        return JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown
      } catch {
        return null
      }
    },
    list: io.list,
    exists: io.exists,
  }
}

const short = (path: string, home: string) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const leaf = (partial: Omit<Item, 'tokens'> & { tokens?: number }): Item => ({
  tokens: partial.tokens ?? estimateTokens(partial.text),
  ...partial,
})

const groupItem = (group: Item['group'], title: string, children: Item[], vanilla: boolean, extra?: Partial<Item>): Item => ({
  id: group,
  group,
  title,
  text: '',
  tokens: children.reduce((n, c) => n + c.tokens, 0),
  vanilla,
  source: { kind: 'unknown' },
  children,
  ...extra,
})

/** Les unités d'un fichier markdown, en items enfants du nœud fichier. */
const fileItem = (
  group: Item['group'],
  path: string,
  text: string,
  tier: Extract<Source, { kind: 'file' }>['tier'],
  home: string,
  extra?: { badges?: string[]; observed?: boolean; indexPath?: string },
): Item => {
  const parsed = parseUnits(text)
  const source: Source = { kind: 'file', path, tier }
  const id = `${group}/${path}`
  const children: Item[] = parsed.units.map(u =>
    leaf({
      id: `${id}#${u.id}`,
      group,
      title: u.title,
      text: u.text,
      vanilla: false,
      source,
      disable: { kind: 'remove-unit', path, unitId: u.id },
      edit: u.isSingleLine ? 'inline' : 'prompt',
      badges: [u.kind, ...(u.headingPath.length ? [u.headingPath.join(' › ')] : [])],
    }),
  )
  return {
    id,
    group,
    title: short(path, home),
    text,
    tokens: estimateTokens(text),
    vanilla: false,
    source,
    disable: { kind: 'remove-file', path, ...(extra?.indexPath ? { indexPath: extra.indexPath } : {}) },
    edit: 'prompt',
    badges: [tier, `${children.length} unité${children.length > 1 ? 's' : ''}`, ...(extra?.badges ?? [])],
    children,
  }
}

// ---------- plugins ----------

export const discoverPlugins = async (r: Reader, io: InventoryIo, env: Env): Promise<PluginInfo[]> => {
  const out: PluginInfo[] = []
  const settings = (await r.json(`${env.home}/.claude/settings.json`)) ?? {}
  const enabled = isRecord(settings) && isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {}
  const installed = await r.json(`${env.home}/.claude/plugins/installed_plugins.json`)
  if (isRecord(installed) && isRecord(installed.plugins)) {
    for (const [key, entries] of Object.entries(installed.plugins)) {
      const [name, marketplace] = key.split('@')
      const first = Array.isArray(entries) && entries.length > 0 ? entries[0] : null
      const root = isRecord(first) && typeof first.installPath === 'string' ? first.installPath : undefined
      const version = isRecord(first) && typeof first.version === 'string' ? first.version : undefined
      const manifest = root ? await r.json(`${root}/.claude-plugin/plugin.json`) : null
      out.push({
        name: name ?? key,
        marketplace,
        root,
        version,
        description: isRecord(manifest) && typeof manifest.description === 'string' ? manifest.description : undefined,
        provenance: 'installed',
        enabled: enabled[key] !== false,
      })
    }
  }
  const syncedRoot = `${env.home}/.claude/plugins/synced`
  for (const bucket of await r.list(syncedRoot)) {
    if (bucket.startsWith('.')) continue
    const manifest = await r.json(`${syncedRoot}/${bucket}/manifest.json`)
    if (!isRecord(manifest) || !Array.isArray(manifest.plugins)) continue
    for (const p of manifest.plugins) {
      if (!isRecord(p) || typeof p.name !== 'string') continue
      const root = `${syncedRoot}/${bucket}/${p.name}`
      out.push({
        name: p.name,
        version: typeof p.version === 'string' ? p.version : undefined,
        description: typeof p.description === 'string' ? p.description : undefined,
        marketplace: typeof p.marketplaceName === 'string' ? p.marketplaceName : 'claude.ai',
        root: (await r.exists(root)) ? root : undefined,
        provenance: 'synced',
        enabled: true,
      })
    }
  }
  const devRoot = `${env.home}/.claude/dev-mods`
  for (const session of await r.list(devRoot)) {
    for (const mod of await r.list(`${devRoot}/${session}`)) {
      const root = `${devRoot}/${session}/${mod}`
      const manifest = await r.json(`${root}/.claude-plugin/plugin.json`)
      if (!isRecord(manifest) || typeof manifest.name !== 'string') continue
      out.push({
        name: manifest.name,
        version: typeof manifest.version === 'string' ? manifest.version : undefined,
        description: typeof manifest.description === 'string' ? manifest.description : undefined,
        root,
        provenance: 'dev',
        enabled: true,
      })
    }
  }
  const inline = await io.pluginDirs()
  for (const root of (inline ?? '').split(':').filter(Boolean)) {
    const manifest = await r.json(`${root}/.claude-plugin/plugin.json`)
    if (!isRecord(manifest) || typeof manifest.name !== 'string') continue
    out.push({ name: manifest.name, root, provenance: 'inline', enabled: true,
      version: typeof manifest.version === 'string' ? manifest.version : undefined,
      description: typeof manifest.description === 'string' ? manifest.description : undefined })
  }
  return out
}

const pluginHint = (p: PluginInfo, env: Env) =>
  p.provenance === 'synced'
    ? 'Plugin synchronisé depuis claude.ai : à couper dans les réglages claude.ai (Plugins), pas localement.'
    : p.provenance === 'dev'
      ? `Mod en développement : retirer le dossier ${short(p.root ?? '', env.home)} ou refuser le hot reload.`
      : p.provenance === 'inline'
        ? 'Chargé par CLAUDE_CODE_PLUGIN_DIRS : retirer le chemin de la variable.'
        : undefined

const pluginDisable = (p: PluginInfo, env: Env): Disable | undefined =>
  p.provenance === 'installed' && p.marketplace
    ? { kind: 'disable-plugin', path: `${env.home}/.claude/settings.json`, plugin: `${p.name}@${p.marketplace}` }
    : undefined

// ---------- hooks (format classique) ----------

type ClassicHook = { event: string; index: number; matcher?: string; entry: unknown }

const classicHooks = (hooks: unknown): ClassicHook[] => {
  if (!isRecord(hooks)) return []
  const out: ClassicHook[] = []
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue
    entries.forEach((entry, index) => {
      const matcher = isRecord(entry) && typeof entry.matcher === 'string' ? entry.matcher : undefined
      out.push({ event, index, matcher, entry })
    })
  }
  return out
}

const hookTitle = (h: ClassicHook) => {
  const cmds = isRecord(h.entry) && Array.isArray(h.entry.hooks)
    ? h.entry.hooks.map(x => (isRecord(x) && typeof x.command === 'string' ? x.command : isRecord(x) && typeof x.type === 'string' ? x.type : '?'))
    : []
  const cmd = cmds.join(' ; ').replace(/\$\{CLAUDE_PLUGIN_ROOT\}\//g, '').replace(/^node "?/, '').replace(/"$/, '')
  return `${h.event}${h.matcher ? ` [${h.matcher}]` : ''} → ${cmd || JSON.stringify(h.entry).slice(0, 60)}`
}

// ---------- construction ----------

export const buildInventory = async (io: InventoryIo, snap: Snapshot | null, env: Env): Promise<Inventory> => {
  const r = makeReader(io)
  const plugins = await discoverPlugins(r, io, env)
  const userPlugins = new Set(plugins.map(p => p.name))
  const userSettingsPath = `${env.home}/.claude/settings.json`

  // --- sections du system prompt
  const engine: Item[] = []
  const app: Item[] = []
  const pluginSections = new Map<string, Item[]>()
  let memoryText: string | null = null
  let mcpText: string | null = null
  const settingsDriven: Item[] = []
  for (const s of snap?.sections ?? []) {
    const src = sectionSource(s.id, userPlugins)
    if (s.id === 'memory' || /^# Memory\b/m.test(s.text)) {
      memoryText = s.text
      continue
    }
    if (/^# MCP Server Instructions/m.test(s.text)) {
      mcpText = s.text
      continue
    }
    if (snap?.outputStyle && /^# Output Style: /m.test(s.text)) {
      settingsDriven.push(leaf({
        id: `settings/section/${s.id}`, group: 'settings', title: `Output style « ${snap.outputStyle} » (section ${s.id})`, text: s.text,
        vanilla: false, source: { kind: 'settings', path: userSettingsPath, keyPath: ['outputStyle'] },
        disable: { kind: 'remove-key', path: userSettingsPath, keyPath: ['outputStyle'] },
        badges: ['settings.outputStyle', s.scope],
      }))
      continue
    }
    const item = leaf({ id: `${src.kind === 'engine' ? 'engine' : src.kind === 'builtin' ? 'app' : 'plugins'}/section/${s.id}`,
      group: src.kind === 'engine' ? 'engine' : src.kind === 'builtin' ? 'app' : 'plugins',
      title: s.id, text: s.text, vanilla: src.kind !== 'plugin', source: src, badges: [s.scope] })
    if (src.kind === 'engine') engine.push(item)
    else if (src.kind === 'builtin') app.push(item)
    else if (src.kind === 'plugin') pluginSections.set(src.name, [...(pluginSections.get(src.name) ?? []), item])
  }
  for (const b of snap?.blocks ?? []) {
    if (b.name === 'claudeMd') continue
    engine.push(leaf({ id: `engine/block/${b.name}`, group: 'engine', title: `bloc de contexte ${b.name}`, text: b.text, vanilla: true, source: { kind: 'engine' }, badges: ['prompt.context'] }))
  }

  // --- CLAUDE.md
  const claudeMd: Item[] = []
  const observedClaudeMd = (snap?.instructionFiles.length ?? 0) > 0
  if (observedClaudeMd) {
    for (const f of snap!.instructionFiles) {
      const text = (await r.text(f.path)) ?? f.content
      const tier = (['managed', 'user', 'project', 'local', 'memory'] as const).find(t => t === f.kind) ?? 'project'
      claudeMd.push(fileItem('claudeMd', f.path, text, tier, env.home, { badges: ['observé', ...(f.parent ? [`importé par ${short(f.parent, env.home)}`] : [])] }))
    }
  } else {
    const push = async (path: string, tier: Extract<Source, { kind: 'file' }>['tier'], badge: string) => {
      const text = await r.text(path)
      if (text !== null) claudeMd.push(fileItem('claudeMd', path, text, tier, env.home, { badges: ['reconstruit', badge] }))
    }
    await push(`${env.home}/.claude/CLAUDE.md`, 'user', 'global')
    for (const name of await r.list(`${env.home}/.claude/rules`)) if (name.endsWith('.md')) await push(`${env.home}/.claude/rules/${name}`, 'rule', 'règle globale')
    let ancestors: Awaited<ReturnType<InventoryIo['ancestors']>> = []
    try {
      ancestors = await io.ancestors(['CLAUDE.md', 'CLAUDE.local.md'])
    } catch {
      ancestors = []
    }
    for (const a of ancestors) {
      for (const part of a.parts) {
        if (claudeMd.some(i => i.source.kind === 'file' && i.source.path === part.path)) continue
        const text = (await r.text(part.path)) ?? part.content
        claudeMd.push(fileItem('claudeMd', part.path, text, a.name.endsWith('.local.md') ? 'local' : 'project', env.home, { badges: ['reconstruit', part.path === `${a.dir}/${a.name}` ? 'chaîne' : 'import'] }))
      }
    }
    await push(`${env.root}/.claude/CLAUDE.md`, 'project', '.claude/')
    for (const name of await r.list(`${env.root}/.claude/rules`)) if (name.endsWith('.md')) await push(`${env.root}/.claude/rules/${name}`, 'rule', 'règle projet')
  }

  // --- mémoire
  const memory: Item[] = []
  const memDirMatch = memoryText?.match(/memory at `([^`]+)`/)
  const memDir = (memDirMatch?.[1] ?? memoryDirFor(env.home, env.cwd)).replace(/\/$/, '')
  const indexPath = `${memDir}/MEMORY.md`
  const indexText = await r.text(indexPath)
  const referenced = new Set<string>()
  if (indexText !== null) {
    const idx = fileItem('memory', indexPath, indexText, 'memory', env.home, { badges: ['index chargé à chaque session'] })
    idx.title = 'MEMORY.md (index)'
    idx.children = (idx.children ?? []).map(u => {
      const m = u.text.match(/\]\(([^)]+\.md)\)/)
      if (!m) return u
      const file = `${memDir}/${m[1]}`
      referenced.add(file)
      return { ...u, disable: { kind: 'remove-file', path: file, indexPath, unitId: u.disable?.unitId }, badges: [...(u.badges ?? []), `→ ${m[1]}`] }
    })
    memory.push(idx)
  }
  for (const name of (await r.list(memDir)).sort()) {
    if (!name.endsWith('.md') || name === 'MEMORY.md') continue
    const path = `${memDir}/${name}`
    const text = await r.text(path)
    if (text === null) continue
    const item = fileItem('memory', path, text, 'memory', env.home, { badges: [referenced.has(path) ? 'indexée' : 'non indexée'], indexPath })
    item.tokens = 0 // lue seulement au rappel : pas de coût permanent
    item.children = (item.children ?? []).map(c => ({ ...c, tokens: 0 }))
    memory.push(item)
  }
  if (memoryText !== null) {
    memory.unshift(leaf({ id: 'memory/section', group: 'memory', title: 'Cadre mémoire (moteur)', text: memoryText, vanilla: true, source: { kind: 'engine' }, badges: ['section memory'] }))
  }

  // --- settings
  const settings: Item[] = [...settingsDriven]
  const hooks: Item[] = []
  const sources: Array<{ source: 'user' | 'project' | 'local'; path: string }> = [
    { source: 'user', path: userSettingsPath },
    { source: 'project', path: `${env.root}/.claude/settings.json` },
    { source: 'local', path: `${env.root}/.claude/settings.local.json` },
  ]
  for (const s of sources) {
    const parsed = await r.json(s.path)
    if (!isRecord(parsed)) continue
    const keys = Object.keys(parsed).sort((a, b) => {
      const ia = BEHAVIOURAL_KEYS.indexOf(a), ib = BEHAVIOURAL_KEYS.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
    })
    for (const key of keys) {
      const value = parsed[key]
      if (key === 'hooks') {
        for (const h of classicHooks(value)) {
          hooks.push(leaf({
            id: `hooks/settings/${s.source}/${h.event}/${h.index}`, group: 'hooks', title: hookTitle(h), text: JSON.stringify(h.entry, null, 2), tokens: 0,
            vanilla: false, source: { kind: 'settings', path: s.path, keyPath: ['hooks', h.event, h.index] },
            disable: { kind: 'remove-hook', path: s.path, keyPath: ['hooks', h.event, h.index] }, edit: 'prompt',
            badges: [`settings ${s.source}`, h.event],
          }))
        }
        continue
      }
      const scalar = typeof value === 'string'
      settings.push(leaf({
        id: `settings/${s.source}/${key}`, group: 'settings', title: key, text: JSON.stringify(value, null, 2) ?? String(value), tokens: 0,
        vanilla: false, source: { kind: 'settings', path: s.path, keyPath: [key] },
        disable: { kind: 'remove-key', path: s.path, keyPath: [key] }, edit: scalar ? 'inline' : 'prompt',
        badges: [`settings ${s.source}`, BEHAVIOURAL_KEYS.includes(key) ? 'comportement' : 'autre'],
      }))
    }
  }

  // --- hooks et sections des plugins
  const pluginItems: Item[] = []
  for (const p of plugins) {
    const children: Item[] = [...(pluginSections.get(p.name) ?? [])]
    if (p.root) {
      const hj = await r.json(`${p.root}/hooks/hooks.json`)
      if (isRecord(hj)) {
        for (const h of classicHooks(hj.hooks)) {
          hooks.push(leaf({
            id: `hooks/plugin/${p.name}/${h.event}/${h.index}`, group: 'hooks', title: `${p.name} · ${hookTitle(h)}`, text: JSON.stringify(h.entry, null, 2), tokens: 0,
            vanilla: false, source: { kind: 'plugin', name: p.name, root: p.root },
            disable: pluginDisable(p, env), edit: 'prompt',
            hint: `Hook du plugin ${p.name} : le mod ne touche pas à la source d'un plugin. Désactiver = couper le plugin entier${pluginHint(p, env) ? ` (${pluginHint(p, env)})` : ''}, modifier = éditer ${short(p.root, env.home)}/hooks/hooks.json puis recharger.`,
            badges: [`plugin ${p.name}`, h.event],
          }))
        }
        if (Array.isArray(hj.modules)) {
          for (const m of hj.modules) {
            if (typeof m !== 'string') continue
            const src = (await r.text(`${p.root}/hooks/${m.replace(/^\.\//, '')}`)) ?? ''
            const events = [...src.matchAll(/on\(\s*['"]([a-z.]+)['"]/g)].map(x => x[1])
            hooks.push(leaf({
              id: `hooks/plugin/${p.name}/module/${m}`, group: 'hooks', title: `${p.name} · module ${m} (${[...new Set(events)].join(', ') || 'événements ?'})`, text: src, tokens: 0,
              vanilla: false, source: { kind: 'plugin', name: p.name, root: p.root }, disable: pluginDisable(p, env),
              hint: pluginHint(p, env) ?? 'Désactiver = couper le plugin entier.', badges: [`plugin ${p.name}`, 'hooks fonctionnels'],
            }))
          }
        }
      }
      const counts: string[] = []
      for (const dir of ['skills', 'commands', 'agents']) {
        const n = (await r.list(`${p.root}/${dir}`)).filter(x => !x.startsWith('.')).length
        if (n > 0) counts.push(`${n} ${dir}`)
      }
      if (counts.length) children.push(leaf({ id: `plugins/${p.name}/contents`, group: 'plugins', title: counts.join(' · '), text: counts.join('\n'), tokens: 0, vanilla: false, source: { kind: 'plugin', name: p.name, root: p.root } }))
    }
    pluginItems.push({
      id: `plugins/${p.name}`, group: 'plugins', title: `${p.name}${p.version ? ` ${p.version}` : ''}${p.enabled ? '' : ' (désactivé)'}`,
      text: [p.description ?? '', '', `Provenance : ${p.provenance}${p.marketplace ? ` (${p.marketplace})` : ''}`, p.root ? `Dossier : ${p.root}` : 'Aucun dossier local : servi par claude.ai.'].join('\n'),
      tokens: children.reduce((n, c) => n + c.tokens, 0), vanilla: false, source: { kind: 'plugin', name: p.name, root: p.root },
      disable: pluginDisable(p, env), hint: pluginHint(p, env), badges: [p.provenance, ...(p.enabled ? [] : ['désactivé'])], children,
    })
  }

  // --- skills et commandes
  const skills: Item[] = []
  const builtinPlugins = new Map<string, string[]>()
  let commands: Awaited<ReturnType<InventoryIo['commands']>> = []
  try {
    commands = await io.commands()
  } catch {
    commands = []
  }
  const loaded = new Map((snap?.skillPrompts ?? []).map(s => [s.skill, s]))
  for (const c of commands) {
    if (c.source === 'builtin') continue
    const loadedPrompt = loaded.get(c.name)
    const base = { group: 'skills' as const, title: `/${c.name}`, vanilla: false }
    if (c.source === 'user') {
      const candidates = [
        { path: `${env.home}/.claude/skills/${c.name}/SKILL.md`, dir: `${env.home}/.claude/skills/${c.name}` },
        { path: `${env.root}/.claude/skills/${c.name}/SKILL.md`, dir: `${env.root}/.claude/skills/${c.name}` },
        { path: `${env.home}/.claude/commands/${c.name}.md` },
        { path: `${env.root}/.claude/commands/${c.name}.md` },
      ]
      let found: { path: string; dir?: string; text: string } | null = null
      for (const cand of candidates) {
        const text = await r.text(cand.path)
        if (text !== null) { found = { ...cand, text }; break }
      }
      skills.push(leaf({
        ...base, id: `skills/${c.name}`, text: `${c.description}\n\n---\n\n${found?.text ?? '(corps introuvable sur disque)'}`, tokens: estimateTokens(c.description),
        source: found ? { kind: 'file', path: found.path, tier: 'skill' } : { kind: 'unknown' },
        disable: found ? (found.dir ? { kind: 'disable-skill', path: found.dir } : { kind: 'remove-file', path: found.path }) : undefined,
        edit: found ? 'prompt' : undefined,
        badges: ['skill perso', `corps ≈ ${estimateTokens(found?.text ?? '')} tok à l'usage`, ...(loadedPrompt ? ['chargé ce tour ou avant'] : [])],
      }))
      continue
    }
    if (c.source === 'plugin') {
      const pluginName = c.plugin ?? c.name.split(':')[0] ?? c.name
      const p = plugins.find(x => x.name === pluginName)
      if (!p) {
        builtinPlugins.set(pluginName, [...(builtinPlugins.get(pluginName) ?? []), c.name])
        continue
      }
      const local = p.root !== undefined
      skills.push(leaf({
        ...base, id: `skills/${c.name}`, text: `${c.description}${loadedPrompt ? `\n\n---\n\n${loadedPrompt.text}` : ''}`, tokens: estimateTokens(c.description),
        source: local ? { kind: 'plugin', name: p.name, root: p.root } : { kind: 'claude-ai', what: `plugin ${p.name}` },
        disable: pluginDisable(p, env),
        hint: local ? `Skill du plugin ${p.name} : désactiver = couper le plugin entier ; modifier = éditer ${short(p.root ?? '', env.home)}/skills/.` : `Skill servi par claude.ai (plugin ${p.name}) : à couper dans les réglages claude.ai.`,
        badges: [`plugin ${p.name}`, local ? 'local' : 'claude.ai', ...(loadedPrompt ? ['chargé'] : [])],
      }))
      continue
    }
    skills.push(leaf({
      ...base, id: `skills/${c.name}`, text: c.description, tokens: estimateTokens(c.description), source: { kind: 'mcp', server: c.plugin ?? '?' },
      hint: 'Prompt exposé par un serveur MCP : à couper avec le serveur.', badges: ['mcp'],
    }))
  }
  // plugins intégrés (app) détectés par leurs commandes, hors plugins de l'utilisateur
  for (const [name, cmds] of builtinPlugins) {
    const sectionsOf = app.filter(i => i.source.kind === 'builtin' && i.source.plugin === name)
    app.push(leaf({ id: `app/plugin/${name}`, group: 'app', title: `plugin intégré ${name}`, text: `Commandes : ${cmds.map(c => `/${c}`).join(', ')}${sectionsOf.length ? `\nSections : ${sectionsOf.map(s => s.title).join(', ')}` : ''}`, tokens: 0, vanilla: true, source: { kind: 'builtin', plugin: name } }))
  }

  // --- MCP
  const mcp: Item[] = []
  const claudeJson = await r.json(`${env.home}/.claude.json`)
  const localServers = new Set<string>()
  if (isRecord(claudeJson)) {
    if (isRecord(claudeJson.mcpServers)) for (const k of Object.keys(claudeJson.mcpServers)) localServers.add(k)
    if (isRecord(claudeJson.projects) && isRecord(claudeJson.projects[env.cwd])) {
      const proj = claudeJson.projects[env.cwd] as Record<string, unknown>
      if (isRecord(proj.mcpServers)) for (const k of Object.keys(proj.mcpServers)) localServers.add(k)
    }
  }
  const projectMcp = await r.json(`${env.root}/.mcp.json`)
  if (isRecord(projectMcp) && isRecord(projectMcp.mcpServers)) for (const k of Object.keys(projectMcp.mcpServers)) localServers.add(k)
  const mcpHint = (server: string) => {
    const m = server.match(/^plugin_(.+?)_[^_]+$/)
    if (m) return `Serveur apporté par le plugin ${m[1]} : à couper avec le plugin.`
    if (localServers.has(server)) return `Serveur configuré localement (~/.claude.json ou .mcp.json) : retirer l'entrée \`${server}\` de mcpServers.`
    return 'Connecteur claude.ai : à déconnecter dans les réglages claude.ai (Connecteurs).'
  }
  if (mcpText !== null) {
    const parts = mcpText.split(/^## (.+)$/m)
    mcp.push(leaf({ id: 'mcp/frame', group: 'mcp', title: 'Cadre MCP (moteur)', text: (parts[0] ?? '').trim(), vanilla: true, source: { kind: 'engine' } }))
    for (let i = 1; i < parts.length; i += 2) {
      const server = (parts[i] ?? '').trim()
      mcp.push(leaf({ id: `mcp/${server}`, group: 'mcp', title: server, text: (parts[i + 1] ?? '').trim(), vanilla: false, source: { kind: 'mcp', server }, hint: mcpHint(server), badges: ['instructions serveur'] }))
    }
  }

  // --- surface (outils et commandes)
  const surface: Item[] = []
  let tools: Awaited<ReturnType<InventoryIo['tools']>> = []
  try {
    tools = await io.tools()
  } catch {
    tools = []
  }
  const byProvider = new Map<string, { names: string[]; tokens: number; vanilla: boolean }>()
  for (const t of tools) {
    const prov = toolProvider(t.name)
    const key = prov.kind === 'mcp' ? `mcp:${prov.server ?? '?'}` : 'engine'
    const cur: { names: string[]; tokens: number; vanilla: boolean } = byProvider.get(key) ?? { names: [], tokens: 0, vanilla: prov.kind !== 'mcp' }
    cur.names.push(t.name)
    // un outil MCP est différé : seul son nom est en contexte ; un outil du moteur y est décrit en entier
    cur.tokens += prov.kind === 'mcp' ? estimateTokens(t.name) : estimateTokens(`${t.name} ${t.description}`)
    byProvider.set(key, cur)
  }
  for (const [key, v] of [...byProvider.entries()].sort((a, b) => Number(a[1].vanilla) - Number(b[1].vanilla) || b[1].tokens - a[1].tokens)) {
    const server = key.startsWith('mcp:') ? key.slice(4) : null
    surface.push(leaf({
      id: `surface/tools/${key}`, group: 'surface', title: `${server ? `outils MCP ${server}` : 'outils du moteur'} : ${v.names.length}`, text: v.names.join('\n'), tokens: v.tokens,
      vanilla: v.vanilla, source: server ? { kind: 'mcp', server } : { kind: 'engine' }, hint: server ? mcpHint(server) : undefined,
      badges: [server ? 'différés (noms seuls)' : 'décrits en entier'],
    }))
    if (server && !mcp.some(i => i.id === `mcp/${server}`)) {
      mcp.push(leaf({ id: `mcp/${server}`, group: 'mcp', title: server, text: `(sans instructions serveur) ${v.names.length} outils`, tokens: 0, vanilla: false, source: { kind: 'mcp', server }, hint: mcpHint(server), badges: ['sans instructions'] }))
    }
  }
  const bySource = new Map<string, string[]>()
  for (const c of commands) bySource.set(c.source, [...(bySource.get(c.source) ?? []), c.name])
  for (const [source, names] of bySource) {
    const text = names.map(n => `/${n}`).join('\n')
    surface.push(leaf({ id: `surface/commands/${source}`, group: 'surface', title: `commandes ${source} : ${names.length}`, text, tokens: source === 'builtin' ? 0 : estimateTokens(text), vanilla: source === 'builtin', source: { kind: source === 'builtin' ? 'engine' : 'unknown' } }))
  }

  const groups: Item[] = [
    groupItem('engine', 'Moteur (vanilla)', engine, true),
    groupItem('app', 'App et plugins intégrés (vanilla)', app, true),
    groupItem('claudeMd', `CLAUDE.md et règles${observedClaudeMd ? '' : ' (reconstruit)'}`, claudeMd, false),
    groupItem('memory', 'Mémoire', memory, false),
    groupItem('settings', 'Settings', settings, false),
    groupItem('hooks', 'Hooks', hooks, false),
    groupItem('plugins', 'Plugins', pluginItems, false),
    groupItem('skills', 'Skills et commandes', skills, false),
    groupItem('mcp', 'Serveurs MCP', mcp, false),
    groupItem('surface', 'Surface : outils et commandes (lecture seule)', surface, false),
  ]
  const leaves = (items: Item[]): Item[] => items.flatMap(i => (i.children && i.children.length ? leaves(i.children) : [i]))
  const nonVanilla = leaves(groups.filter(g => g.id !== 'surface')).filter(i => !i.vanilla)
  const surfaceTokens = surface.filter(i => !i.vanilla).reduce((n, i) => n + i.tokens, 0)
  return {
    builtAt: env.now,
    groups,
    watched: [...r.watched],
    count: nonVanilla.length,
    tokens: nonVanilla.reduce((n, i) => n + i.tokens, 0) + surfaceTokens,
    observedClaudeMd,
  }
}
