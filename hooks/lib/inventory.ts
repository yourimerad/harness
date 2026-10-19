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
import { estimateTokens, formatTokens } from './tokens'

export type Env = { home: string; cwd: string; root: string; now: string }

/** Les entrées-sorties dont l'inventaire a besoin ; construites dans le module de hooks autour de `$`. */
export type InventoryIo = {
  readText: (path: string) => Promise<string | null>
  list: (path: string) => Promise<string[]>
  exists: (path: string) => Promise<boolean>
  pluginDirs: () => Promise<string | undefined>
  ancestors: (names: string[]) => Promise<readonly { dir: string; name: string; parts: readonly { path: string; content: string }[] }[]>
  commands: () => Promise<readonly { name: string; description: string; source: 'builtin' | 'plugin' | 'user' | 'mcp'; plugin?: string }[]>
  tools: () => Promise<readonly { name: string; description: string; mcp: boolean }[]>
  /** La ventilation /context (`$.session.usage({ breakdown: 'summary' })`), ou null quand le moteur ne la donne pas. */
  usage: () => Promise<ContextBreakdown | null>
}

/** Ce que l'inventaire lit de la ventilation /context : les mesures du moteur, jamais recalculées. */
export type ContextBreakdown = {
  categories: readonly { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }[]
  memoryFiles: readonly { path: string; type: string; tokens: number }[]
  mcpTools: readonly { name: string; serverName: string; tokens: number; isLoaded: boolean }[]
  agents: readonly { agentType: string; source: string; tokens: number }[]
  skills?: { totalSkills: number; includedSkills: number; tokens: number; skillFrontmatter: readonly { name: string; source: string; pluginName?: string; tokens: number }[] }
  slashCommands?: { totalCommands: number; includedCommands: number; tokens: number }
}

export type PluginInfo = {
  name: string
  version?: string
  description?: string
  /** Le dossier que le moteur lit ; pour une marketplace « directory », la source elle-même, pas la copie de plugins/cache. */
  root?: string
  /** La copie laissée par `claude plugin install` quand le moteur lit ailleurs (`root`). */
  installPath?: string
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

/** Comparaison lâche entre le texte chargé par le moteur (frontmatter et commentaires retirés) et le disque. */
const loose = (text: string) =>
  text
    .replace(/^\uFEFF/, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Caractères de journal gardés pour le pane. */
const JOURNAL_TAIL = 6000
/** Poids retenu pour un style de sortie intégré, dont le prompt n'est pas lisible sur disque : « Concise » mesuré à 1 349 caractères le 2026-10-19. */
const BUILTIN_STYLE_TOKENS = 400

/** La fin d'un journal, coupée au début d'une entrée (`## …`) quand elle dépasse `max` caractères ; l'en-tête saute alors. */
export const journalTail = (text: string, max: number): string => {
  if (text.length <= max) return text
  const tail = text.slice(text.length - max)
  const at = tail.indexOf('\n## ')
  return at >= 0 ? tail.slice(at + 1) : tail
}

/** Un serveur MCP tel que les noms d'outils l'épellent (`plugin:x:gmail` → `plugin_x_gmail`, `claude.ai Gmail` → `claude_ai_Gmail`). */
export const mcpKey = (server: string) => server.replace(/[^A-Za-z0-9_-]/g, '_')

/** Un texte reçu par le modèle : section du system prompt, bloc du premier message ou reminder. */
type Carried = { key: string; text: string; via: string; badge: string }

/**
 * La tranche d'un texte qui commence à la ligne de titre `# …` reconnue par `start` et s'arrête au prochain
 * titre de niveau 1 (ou à la fin) ; `keep` prolonge sur un titre voisin du même sujet. `rest` = le texte sans la tranche.
 * Null quand aucune ligne ne commence la tranche.
 */
export const sliceHeading = (text: string, start: RegExp, keep?: RegExp): { slice: string; rest: string } | null => {
  const lines = text.split('\n')
  const from = lines.findIndex(l => start.test(l))
  if (from < 0) return null
  let to = from + 1
  while (to < lines.length && !(/^# /.test(lines[to]!) && !keep?.test(lines[to]!)) && !LISTING_OPENER.test(lines[to]!)) to++
  return { slice: lines.slice(from, to).join('\n').trim(), rest: [...lines.slice(0, from), ...lines.slice(to)].join('\n') }
}

/** Les paragraphes sans titre par lesquels le moteur ouvre une liste (outils différés, agents, skills, date) : ils bornent une tranche. */
const LISTING_OPENER = /^(The following (deferred tools|skills are available|MCP servers (require|are still))|Available agent types|Today's date|While auto mode|Claude cannot start the OAuth)/

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
      // l'édition in-pane ne vaut que pour une puce ou un paragraphe d'une ligne : ailleurs elle fusionnerait des voisins
      edit: u.isSingleLine && (u.kind === 'bullet' || u.kind === 'paragraph') ? 'inline' : 'prompt',
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

/** Chemin joint sans module `path` : segments `.` ignorés, `..` remontés. */
const joinPath = (base: string, rel: string): string => {
  const parts = base.split('/').filter(Boolean)
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return `/${parts.join('/')}`
}

/** Le dossier d'où le moteur lit un plugin d'une marketplace « directory » (`claude plugin list` : « Read from ») : la
 *  source relative que le marketplace.json de ce dossier déclare. Pour toute autre marketplace, undefined (la copie fait foi). */
const readFromFolder = async (r: Reader, marketplaces: unknown, name: string, marketplace: string | undefined): Promise<string | undefined> => {
  if (!marketplace || !isRecord(marketplaces)) return undefined
  const m = marketplaces[marketplace]
  if (!isRecord(m) || !isRecord(m.source) || m.source.source !== 'directory') return undefined
  const location = typeof m.installLocation === 'string' ? m.installLocation : typeof m.source.path === 'string' ? m.source.path : undefined
  if (!location) return undefined
  const manifest = await r.json(`${location}/.claude-plugin/marketplace.json`)
  if (!isRecord(manifest) || !Array.isArray(manifest.plugins)) return undefined
  const entry = manifest.plugins.find(p => isRecord(p) && p.name === name)
  const source = isRecord(entry) && typeof entry.source === 'string' ? entry.source : undefined
  if (source === undefined || /^[a-z]+:/i.test(source)) return undefined
  return joinPath(location, source)
}

export const discoverPlugins = async (r: Reader, io: InventoryIo, env: Env): Promise<PluginInfo[]> => {
  const out: PluginInfo[] = []
  const settings = (await r.json(`${env.home}/.claude/settings.json`)) ?? {}
  const enabled = isRecord(settings) && isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {}
  const installed = await r.json(`${env.home}/.claude/plugins/installed_plugins.json`)
  const marketplaces = await r.json(`${env.home}/.claude/plugins/known_marketplaces.json`)
  if (isRecord(installed) && isRecord(installed.plugins)) {
    for (const [key, entries] of Object.entries(installed.plugins)) {
      const [name, marketplace] = key.split('@')
      const first = Array.isArray(entries) && entries.length > 0 ? entries[0] : null
      const installPath = isRecord(first) && typeof first.installPath === 'string' ? first.installPath : undefined
      const folder = await readFromFolder(r, marketplaces, name ?? key, marketplace)
      const root = folder ?? installPath
      const version = isRecord(first) && typeof first.version === 'string' ? first.version : undefined
      const manifest = root ? await r.json(`${root}/.claude-plugin/plugin.json`) : null
      out.push({
        name: name ?? key,
        marketplace,
        root,
        ...(folder && installPath && folder !== installPath ? { installPath } : {}),
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
      const local = (await r.exists(root)) ? await r.json(`${root}/.claude-plugin/plugin.json`) : null
      out.push({
        name: p.name,
        version: isRecord(local) && typeof local.version === 'string' ? local.version : typeof p.version === 'string' ? p.version : undefined,
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

// ---------- style de sortie ----------

/** Le fichier d'un style de sortie : `name:` du frontmatter ou nom de fichier, sans la casse, projet avant utilisateur. */
const findStyleFile = async (r: Reader, env: Env, name: string): Promise<{ path: string; text: string } | null> => {
  const wanted = name.trim().toLowerCase()
  for (const dir of [`${env.root}/.claude/output-styles`, `${env.home}/.claude/output-styles`]) {
    for (const file of (await r.list(dir)).sort()) {
      if (!file.endsWith('.md')) continue
      const path = `${dir}/${file}`
      const text = await r.text(path)
      if (text === null) continue
      const declared = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '')
      if ((declared ?? '').toLowerCase() === wanted || file.slice(0, -3).toLowerCase() === wanted) return { path, text }
    }
  }
  return null
}

/**
 * L'item du style de sortie quand aucun marqueur `# Output Style:` n'a été observé : sous le preset SDK (app de bureau)
 * le prompt du style voyage dans le tour système du premier message, hors de portée des hooks. Il est reconstruit
 * depuis `settings.outputStyle` et le fichier du style s'il est sur disque ; un style intégré n'a pas de texte lisible.
 */
const outputStyleItem = async (r: Reader, env: Env, chosen: { source: string; path: string; name: string }): Promise<Item> => {
  const file = await findStyleFile(r, env, chosen.name)
  const disable: Disable = { kind: 'remove-key', path: chosen.path, keyPath: ['outputStyle'] }
  if (file) {
    const body = file.text.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
    return leaf({
      id: 'settings/style', group: 'settings', title: `Output style « ${chosen.name} »`, text: body, vanilla: false,
      source: { kind: 'file', path: file.path, tier: file.path.startsWith(`${env.home}/.claude/`) ? 'user' : 'project' },
      disable, edit: 'prompt',
      badges: [`settings ${chosen.source}.outputStyle`, 'prompt du style lu sur disque', 'non observé par un hook (preset SDK)'],
    })
  }
  return leaf({
    id: 'settings/style', group: 'settings', title: `Output style « ${chosen.name} »`, tokens: BUILTIN_STYLE_TOKENS, vanilla: false,
    text: `Style « ${chosen.name} » choisi par settings.outputStyle (${chosen.source}). Son prompt complet est envoyé au modèle dans le tour système du premier message, hors de portée des hooks, et aucun fichier ~/.claude/output-styles/<nom>.md ni .claude/output-styles/<nom>.md ne le porte : style intégré, texte non lisible par le mod. Poids estimé à ${BUILTIN_STYLE_TOKENS} tok (« Concise » mesuré à 1 349 caractères).`,
    source: { kind: 'settings', path: chosen.path, keyPath: ['outputStyle'] },
    disable, edit: 'inline',
    badges: [`settings ${chosen.source}.outputStyle`, 'style intégré : texte non lisible', 'poids estimé'],
  })
}

// ---------- construction ----------

export const buildInventory = async (io: InventoryIo, snap: Snapshot | null, env: Env): Promise<Inventory> => {
  const r = makeReader(io)
  const plugins = await discoverPlugins(r, io, env)
  const userPlugins = new Set(plugins.map(p => p.name))
  const userSettingsPath = `${env.home}/.claude/settings.json`
  // La mesure du moteur : ce que /context compte vraiment (outils MCP chargés ou différés, agents, listing des skills,
  // fichiers d'instructions chargés). Absente, l'inventaire estime comme avant.
  let bd: ContextBreakdown | null = null
  try {
    bd = await io.usage()
  } catch {
    bd = null
  }
  const category = (re: RegExp) => bd?.categories.find(c => re.test(c.name)) ?? null
  const MEASURED = 'mesuré par /context'

  // --- sections du system prompt, blocs du premier message, reminders : les mêmes marqueurs partout.
  // Sous le preset SDK (app de bureau), le cadre mémoire, le style de sortie et les instructions MCP ne sont
  // pas toujours des sections : ils voyagent dans le premier message (`prompt.context`) ou en reminder
  // (`prompt.attachment`), parfois plusieurs sujets dans un même texte. On découpe au titre de niveau 1.
  const engine: Item[] = []
  const app: Item[] = []
  const pluginSections = new Map<string, Item[]>()
  let memoryText: string | null = null
  const mcpTexts: Array<{ text: string; via: string }> = []
  const settingsDriven: Item[] = []
  const carried: Carried[] = [
    ...(snap?.sections ?? []).map(s => ({ key: s.id, text: s.text, via: `section ${s.id}`, badge: s.scope })),
    ...(snap?.blocks ?? []).filter(b => b.name !== 'claudeMd').map(b => ({ key: `block:${b.name}`, text: b.text, via: `bloc ${b.name}`, badge: 'prompt.context' })),
    ...(snap?.attachments ?? []).map(a => ({ key: `attachment:${a.type}`, text: a.text, via: `reminder ${a.type}`, badge: 'prompt.attachment' })),
  ]
  for (const c of carried) {
    let rest = c.text
    if (memoryText === null) {
      const cut = c.key === 'memory' ? { slice: rest, rest: '' } : sliceHeading(rest, /^# Memory\b/)
      if (cut) {
        memoryText = cut.slice
        rest = cut.rest
      }
    }
    const mcpCut = sliceHeading(rest, /^# MCP Server Instructions/)
    if (mcpCut) {
      mcpTexts.push({ text: mcpCut.slice, via: c.via })
      rest = mcpCut.rest
    }
    const styleCut = sliceHeading(rest, /^# Output Style: /, /^# .*Style Active\b/)
    if (styleCut) {
      rest = styleCut.rest
      const name = styleCut.slice.match(/^# Output Style: (.+)$/m)?.[1]?.trim() ?? snap?.outputStyle ?? '?'
      if (!settingsDriven.length) {
        settingsDriven.push(leaf({
          id: `settings/section/${c.key}`, group: 'settings', title: `Output style « ${name} » (${c.via})`, text: styleCut.slice,
          vanilla: false, source: { kind: 'settings', path: userSettingsPath, keyPath: ['outputStyle'] },
          disable: { kind: 'remove-key', path: userSettingsPath, keyPath: ['outputStyle'] },
          badges: ['settings.outputStyle', c.badge],
        }))
      }
    }
    if (c.key.startsWith('attachment:')) continue // les reminders sont listés par le pane (groupe « Reminders observés »)
    if (rest.trim() === '') continue
    if (c.key.startsWith('block:')) {
      const name = c.key.slice('block:'.length)
      engine.push(leaf({ id: `engine/block/${name}`, group: 'engine', title: `bloc de contexte ${name}`, text: rest, vanilla: true, source: { kind: 'engine' }, badges: ['prompt.context'] }))
      continue
    }
    const src = sectionSource(c.key, userPlugins)
    const item = leaf({ id: `${src.kind === 'engine' ? 'engine' : src.kind === 'builtin' ? 'app' : 'plugins'}/section/${c.key}`,
      group: src.kind === 'engine' ? 'engine' : src.kind === 'builtin' ? 'app' : 'plugins',
      title: c.key, text: rest, vanilla: src.kind !== 'plugin', source: src, badges: [c.badge] })
    if (src.kind === 'engine') engine.push(item)
    else if (src.kind === 'builtin') app.push(item)
    else if (src.kind === 'plugin') pluginSections.set(src.name, [...(pluginSections.get(src.name) ?? []), item])
  }

  // --- CLAUDE.md : ce que le moteur a chargé (observé), puis ce qu'il chargerait depuis le disque (non chargé dans cette session)
  const claudeMd: Item[] = []
  const observed = snap?.instructionFiles ?? []
  const observedClaudeMd = observed.length > 0
  const seen = new Set<string>()
  // L'index mémoire voyage dans le même bloc que les CLAUDE.md (kind `memory`) : il est listé une fois, dans « Mémoire ».
  const observedIndex = observed.find(f => f.kind === 'memory')
  for (const f of observed) {
    if (f.kind === 'memory') {
      seen.add(f.path)
      continue
    }
    const disk = await r.text(f.path)
    const text = disk ?? f.content
    const tier = (['managed', 'user', 'project', 'local', 'memory'] as const).find(t => t === f.kind) ?? 'project'
    const badges = ['observé']
    if (disk !== null && loose(disk) !== loose(f.content)) badges.push('disque ≠ contexte : le moteur relira le fichier à la prochaine session')
    if (f.parent) badges.push(`importé par ${short(f.parent, env.home)}`)
    claudeMd.push(fileItem('claudeMd', f.path, text, tier, env.home, { badges }))
    seen.add(f.path)
  }
  // Sans `prompt.context` (mod chargé en cours de session), /context dit quand même quels fichiers le moteur a chargés.
  const loadedFiles = new Set((bd?.memoryFiles ?? []).map(f => f.path))
  const diskBadge = (path: string) =>
    observedClaudeMd || loadedFiles.size === 0 ? (observedClaudeMd ? 'sur disque, non chargé dans cette session' : 'reconstruit') : loadedFiles.has(path) ? `chargé (${MEASURED})` : 'sur disque, non chargé dans cette session'
  const pushDisk = async (path: string, tier: Extract<Source, { kind: 'file' }>['tier'], badge: string) => {
    if (seen.has(path)) return
    const text = await r.text(path)
    if (text === null) return
    seen.add(path)
    claudeMd.push(fileItem('claudeMd', path, text, tier, env.home, { badges: [diskBadge(path), badge] }))
  }
  await pushDisk(`${env.home}/.claude/CLAUDE.md`, 'user', 'global')
  for (const name of await r.list(`${env.home}/.claude/rules`)) if (name.endsWith('.md')) await pushDisk(`${env.home}/.claude/rules/${name}`, 'rule', 'règle globale')
  let ancestors: Awaited<ReturnType<InventoryIo['ancestors']>> = []
  try {
    ancestors = await io.ancestors(['CLAUDE.md', 'CLAUDE.local.md'])
  } catch {
    ancestors = []
  }
  for (const a of ancestors) {
    for (const part of a.parts) {
      await pushDisk(part.path, a.name.endsWith('.local.md') ? 'local' : 'project', part.path === `${a.dir}/${a.name}` ? 'chaîne' : 'import')
    }
  }
  for (const dir of [...new Set([env.cwd, env.root])]) {
    await pushDisk(`${dir}/CLAUDE.md`, 'project', 'dossier de travail')
    await pushDisk(`${dir}/CLAUDE.local.md`, 'local', 'dossier de travail')
    await pushDisk(`${dir}/.claude/CLAUDE.md`, 'project', '.claude/')
    for (const name of await r.list(`${dir}/.claude/rules`)) if (name.endsWith('.md')) await pushDisk(`${dir}/.claude/rules/${name}`, 'rule', 'règle projet')
  }
  for (const f of bd?.memoryFiles ?? []) {
    if (f.type === 'AutoMem' || f.path.endsWith('/MEMORY.md')) continue
    const tier = ({ User: 'user', Project: 'project', Local: 'local', Managed: 'managed' } as const)[f.type] ?? 'project'
    await pushDisk(f.path, tier, 'chargé hors de la chaîne connue')
  }

  // --- mémoire
  const memory: Item[] = []
  const memDirMatch = memoryText?.match(/memory at `([^`]+)`/)
  const memDir = (observedIndex?.path.replace(/\/MEMORY\.md$/, '') ?? memDirMatch?.[1] ?? memoryDirFor(env.home, env.cwd)).replace(/\/$/, '')
  const indexPath = `${memDir}/MEMORY.md`
  const indexText = (await r.text(indexPath)) ?? observedIndex?.content ?? null
  const referenced = new Set<string>()
  if (indexText !== null) {
    const idx = fileItem('memory', indexPath, indexText, 'memory', env.home, { badges: ['index chargé à chaque session', ...(observedIndex ? ['observé'] : [])] })
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
  let chosenStyle: { source: string; path: string; name: string } | null = null
  for (const s of sources) {
    const parsed = await r.json(s.path)
    if (!isRecord(parsed)) continue
    // la précédence monte de user à local : la dernière source qui porte la clé gagne
    if (typeof parsed.outputStyle === 'string' && parsed.outputStyle.trim()) chosenStyle = { source: s.source, path: s.path, name: parsed.outputStyle.trim() }
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

  // --- style de sortie : construit depuis settings et le disque quand aucun marqueur n'a été observé (pas de doublon sinon)
  if (!settingsDriven.length && chosenStyle) settings.unshift(await outputStyleItem(r, env, chosenStyle))

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
      text: [p.description ?? '', '', `Provenance : ${p.provenance}${p.marketplace ? ` (${p.marketplace})` : ''}`, p.root ? `Dossier : ${p.root}` : 'Aucun dossier local : servi par claude.ai.', ...(p.installPath ? [`Copie d'installation (non lue) : ${p.installPath}`] : [])].join('\n'),
      tokens: children.reduce((n, c) => n + c.tokens, 0), vanilla: false, source: { kind: 'plugin', name: p.name, root: p.root },
      disable: pluginDisable(p, env), hint: pluginHint(p, env), badges: [p.provenance, ...(p.installPath ? ['lu depuis son dossier'] : []), ...(p.enabled ? [] : ['désactivé'])], children,
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
  // Le listing envoyé au modèle est borné par un budget : /context dit quels skills y figurent et pour combien.
  const listed = bd?.skills ? bd.skills.skillFrontmatter : null
  const listing = (name: string, fallback: number): { tokens: number; badges: string[] } => {
    if (!listed) return { tokens: fallback, badges: [] }
    const bare = name.slice(name.lastIndexOf(':') + 1)
    const exact = listed.filter(s => s.name === name)
    const hits = exact.length ? exact : listed.filter(s => s.name === bare)
    return hits.length === 1 ? { tokens: hits[0]!.tokens, badges: [`listé (${MEASURED})`] } : { tokens: 0, badges: ['hors du listing envoyé au modèle (budget) : 0 tok'] }
  }
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
        ...base, id: `skills/${c.name}`, text: `${c.description}\n\n---\n\n${found?.text ?? '(corps introuvable sur disque)'}`, tokens: listing(c.name, estimateTokens(c.description)).tokens,
        source: found ? { kind: 'file', path: found.path, tier: 'skill' } : { kind: 'unknown' },
        disable: found ? (found.dir ? { kind: 'disable-skill', path: found.dir } : { kind: 'remove-file', path: found.path }) : undefined,
        edit: found ? 'prompt' : undefined,
        badges: ['skill perso', ...listing(c.name, 0).badges, `corps ≈ ${estimateTokens(found?.text ?? '')} tok à l'usage`, ...(loadedPrompt ? ['chargé ce tour ou avant'] : [])],
      }))
      continue
    }
    if (c.source === 'plugin') {
      const pluginName = c.plugin ?? c.name.split(':')[0] ?? c.name
      const found = plugins.find(x => x.name === pluginName)
      // Un plugin absent du disque et sans section dans le system prompt est servi par claude.ai (non-vanilla) ;
      // un plugin absent du disque qui écrit dans le system prompt fait partie de l'app (vanilla), `ccd` compris.
      const isAppPlugin = !found && (pluginName === 'ccd' || pluginName.startsWith('ccd_') || app.some(i => i.source.kind === 'builtin' && i.source.plugin === pluginName))
      if (isAppPlugin) {
        builtinPlugins.set(pluginName, [...(builtinPlugins.get(pluginName) ?? []), c.name])
        continue
      }
      const p: PluginInfo = found ?? { name: pluginName, provenance: 'synced', enabled: true, marketplace: 'claude.ai' }
      if (!found && !pluginItems.some(i => i.id === `plugins/${pluginName}`)) {
        pluginItems.push({
          id: `plugins/${pluginName}`, group: 'plugins', title: pluginName, text: `Plugin servi par claude.ai : aucun dossier local. Ses skills et connecteurs arrivent par ton compte claude.ai.`,
          tokens: 0, vanilla: false, source: { kind: 'claude-ai', what: `plugin ${pluginName}` }, hint: pluginHint(p, env), badges: ['claude.ai'], children: [],
        })
      }
      const local = p.root !== undefined
      skills.push(leaf({
        ...base, id: `skills/${c.name}`, text: `${c.description}${loadedPrompt ? `\n\n---\n\n${loadedPrompt.text}` : ''}`, tokens: listing(c.name, estimateTokens(c.description)).tokens,
        source: local ? { kind: 'plugin', name: p.name, root: p.root } : { kind: 'claude-ai', what: `plugin ${p.name}` },
        disable: pluginDisable(p, env),
        hint: local ? `Skill du plugin ${p.name} : désactiver = couper le plugin entier ; modifier = éditer ${short(p.root ?? '', env.home)}/skills/.` : `Skill servi par claude.ai (plugin ${p.name}) : à couper dans les réglages claude.ai.`,
        badges: [`plugin ${p.name}`, local ? 'local' : 'claude.ai', ...listing(c.name, 0).badges, ...(loadedPrompt ? ['chargé'] : [])],
      }))
      continue
    }
    skills.push(leaf({
      ...base, id: `skills/${c.name}`, text: c.description, tokens: listing(c.name, estimateTokens(c.description)).tokens, source: { kind: 'mcp', server: c.plugin ?? '?' },
      hint: 'Prompt exposé par un serveur MCP : à couper avec le serveur.', badges: ['mcp', ...listing(c.name, 0).badges],
    }))
  }
  // agents personnalisés : leur description vit dans l'outil Agent, /context les mesure ; le mod n'écrit pas dans agents/
  for (const a of bd?.agents ?? []) {
    const prefix = a.agentType.includes(':') ? a.agentType.slice(0, a.agentType.indexOf(':')) : a.agentType
    const p = a.source === 'plugin' ? plugins.find(x => x.name === prefix) : undefined
    const isPlugin = a.source === 'plugin'
    const file = `${a.source === 'projectSettings' ? env.root : env.home}/.claude/agents/${a.agentType}.md`
    skills.push(leaf({
      id: `skills/agent/${a.agentType}`, group: 'skills', title: `agent ${a.agentType}`, tokens: a.tokens, vanilla: false,
      text: `Type d'agent décrit au modèle dans l'outil Agent (source ${a.source}).`,
      source: isPlugin ? (p?.root ? { kind: 'plugin', name: p.name, root: p.root } : { kind: 'claude-ai', what: `plugin ${prefix}` }) : { kind: 'file', path: file, tier: 'agent' },
      disable: isPlugin && p ? pluginDisable(p, env) : undefined,
      hint: isPlugin
        ? p?.root ? `Agent du plugin ${p.name} : désactiver = couper le plugin entier ; modifier = éditer ${short(p.root, env.home)}/agents/.` : `Agent servi par claude.ai (plugin ${prefix}) : à couper dans les réglages claude.ai.`
        : `Agent personnalisé : hors du périmètre d'écriture du mod, retirer ${short(file, env.home)} à la main.`,
      badges: ['agent', a.source, MEASURED],
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
    const m = server.match(/^plugin[_:](.+?)[_:][^_:]+$/)
    if (m) return `Serveur apporté par le plugin ${m[1]} : à couper avec le plugin.`
    if (localServers.has(server)) return `Serveur configuré localement (~/.claude.json ou .mcp.json) : retirer l'entrée \`${server}\` de mcpServers.`
    return 'Connecteur claude.ai : à déconnecter dans les réglages claude.ai (Connecteurs).'
  }
  // Les instructions serveur arrivent en une ou plusieurs fois (section, premier message, reminder d'un serveur
  // connecté plus tard) : un item par serveur, le premier texte reçu fait foi ; le cadre vient du premier texte.
  for (const { text, via } of mcpTexts) {
    const parts = text.split(/^## (.+)$/m)
    if (!mcp.some(i => i.id === 'mcp/frame')) {
      mcp.push(leaf({ id: 'mcp/frame', group: 'mcp', title: 'Cadre MCP (moteur)', text: (parts[0] ?? '').trim(), vanilla: true, source: { kind: 'engine' }, badges: [via] }))
    }
    for (let i = 1; i < parts.length; i += 2) {
      const server = (parts[i] ?? '').trim()
      if (mcp.some(i => i.id === `mcp/${server}`)) continue
      mcp.push(leaf({ id: `mcp/${server}`, group: 'mcp', title: server, text: (parts[i + 1] ?? '').trim(), vanilla: false, source: { kind: 'mcp', server }, hint: mcpHint(server), badges: ['instructions serveur', via] }))
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
  // /context mesure chaque outil MCP et dit s'il est chargé (schéma en contexte) ou différé (nom seul derrière ToolSearch) ;
  // les outils du moteur sont comptés ensemble (catégorie « System tools »). Sans mesure : un outil MCP est différé, un
  // outil du moteur décrit en entier.
  const measured = new Map((bd?.mcpTools ?? []).map(t => [t.name, t]))
  type Provider = { names: string[]; tokens: number; vanilla: boolean; loaded: number; label?: string }
  const byProvider = new Map<string, Provider>()
  const add = (name: string, description: string) => {
    const prov = toolProvider(name)
    const key = prov.kind === 'mcp' ? `mcp:${prov.server ?? '?'}` : 'engine'
    const cur: Provider = byProvider.get(key) ?? { names: [], tokens: 0, vanilla: prov.kind !== 'mcp', loaded: 0 }
    cur.names.push(name)
    const m = measured.get(name)
    if (m) cur.label = m.serverName
    if (prov.kind !== 'mcp') cur.tokens += estimateTokens(`${name} ${description}`)
    else if (m?.isLoaded) {
      cur.tokens += m.tokens
      cur.loaded++
    } else cur.tokens += estimateTokens(name)
    byProvider.set(key, cur)
  }
  for (const t of tools) add(t.name, t.description)
  for (const [name] of measured) if (!tools.some(t => t.name === name)) add(name, '')
  const systemTools = category(/^system tools$/i)
  const engineTools = byProvider.get('engine')
  if (engineTools && systemTools) engineTools.tokens = systemTools.tokens
  for (const [key, v] of [...byProvider.entries()].sort((a, b) => Number(a[1].vanilla) - Number(b[1].vanilla) || b[1].tokens - a[1].tokens)) {
    const server = key.startsWith('mcp:') ? key.slice(4) : null
    const shown = v.label && v.label !== server ? `${v.label} (${server})` : server
    surface.push(leaf({
      id: `surface/tools/${key}`, group: 'surface', title: `${server ? `outils MCP ${shown}` : 'outils du moteur'} : ${v.names.length}`, text: v.names.join('\n'), tokens: v.tokens,
      vanilla: v.vanilla, source: server ? { kind: 'mcp', server } : { kind: 'engine' }, hint: server ? mcpHint(server) : undefined,
      badges: server
        ? measured.size ? [`${v.loaded} chargés en entier`, `${v.names.length - v.loaded} différés (noms seuls)`, MEASURED] : ['différés (noms seuls)']
        : systemTools ? ['décrits en entier', MEASURED] : ['décrits en entier'],
    }))
    if (server && !mcp.some(i => i.source.kind === 'mcp' && mcpKey(i.source.server) === mcpKey(server))) {
      // Aucune API côté hooks n'expose les instructions d'un serveur MCP : quand elles n'ont pas été vues en section,
      // bloc ou reminder, on ne sait pas si le serveur en envoie (sous le preset SDK elles arrivent par
      // `mcp_instructions_delta` dans le tour système) ; le dire plutôt qu'affirmer « sans instructions ».
      mcp.push(leaf({
        id: `mcp/${server}`, group: 'mcp', title: server, tokens: 0, vanilla: false, source: { kind: 'mcp', server }, hint: mcpHint(server),
        text: `Instructions serveur non observables : aucune API côté hooks ne les expose, et aucun marqueur « # MCP Server Instructions » ne les a portées pour ${server}. Si ce serveur en envoie, elles arrivent au modèle dans le tour système du premier message (mcp_instructions_delta), hors de portée du mod, et pèsent sans être comptées ici. ${v.names.length} outil${v.names.length > 1 ? 's' : ''}.`,
        badges: ['instructions non observables', 'poids non compté'],
      }))
    }
  }
  const bySource = new Map<string, string[]>()
  for (const c of commands) bySource.set(c.source, [...(bySource.get(c.source) ?? []), c.name])
  for (const [source, names] of bySource) {
    const text = names.map(n => `/${n}`).join('\n')
    surface.push(leaf({ id: `surface/commands/${source}`, group: 'surface', title: `commandes ${source} : ${names.length}`, text, tokens: source === 'builtin' ? 0 : estimateTokens(text), vanilla: source === 'builtin', source: { kind: source === 'builtin' ? 'engine' : 'unknown' } }))
  }

  // Ce que le moteur compte comme system prompt au-delà des sections : la prose ajoutée par l'hôte (SDK
  // `systemPrompt.append`, l'app de bureau), qu'aucun hook n'observe. Signalée quand la mesure dépasse nettement
  // l'estimation des sections (les deux estiment : une marge absorbe l'écart d'estimateur).
  const systemPrompt = category(/^system prompt$/i)
  const sectionsTokens = (snap?.sections ?? []).reduce((n, s) => n + estimateTokens(s.text), 0)
  if (systemPrompt && sectionsTokens > 0 && systemPrompt.tokens > sectionsTokens * 1.25 + 200) {
    const rest = systemPrompt.tokens - sectionsTokens
    app.push(leaf({
      id: 'app/system-prompt-rest', group: 'app', title: `prose du system prompt hors sections (${formatTokens(rest)} tok)`, tokens: rest, vanilla: true,
      source: { kind: 'builtin', plugin: 'hôte' },
      text: `/context compte ${formatTokens(systemPrompt.tokens)} tok de system prompt ; les ${snap?.sections.length ?? 0} sections listées par prompt.compose en font ${formatTokens(sectionsTokens)}. Le reste est ajouté par l'hôte (SDK : systemPrompt.append — l'app de bureau) après les sections : aucun hook ne le voit, il n'est ni listé ni coupable ici.`,
      badges: [MEASURED, 'non observable par un hook'],
    }))
  }

  // --- journal du mod : sa fin, par entrées entières ; le pane l'affiche dans la vue Journal
  const journalText = await r.text(`${env.home}/.claude/harness/journal.md`)
  const journal = journalText === null ? null : journalTail(journalText, JOURNAL_TAIL)

  const groups: Item[] = [
    groupItem('engine', 'Moteur (vanilla)', engine, true),
    groupItem('app', 'App et plugins intégrés (vanilla)', app, true),
    groupItem('claudeMd', `CLAUDE.md et règles${observedClaudeMd ? '' : ' (reconstruit depuis le disque)'}`, claudeMd, false),
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
    journal,
  }
}
