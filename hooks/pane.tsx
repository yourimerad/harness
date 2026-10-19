// Le rendu du pane « Harnais » : une barre de vues (Résumé, Instructions, Réglages, Skills, MCP & outils, Moteur,
// Journal), puis dans chaque vue l'arbre des groupes concernés et le détail de l'élément choisi.
// Pur : reçoit l'état et des handlers. Le terminal étroit (pane inline) empile l'arbre et le détail.
import type { Elements, RenderInput } from 'claude-code'

import type { HarnessInventory as Inventory, HarnessItem as Item, HarnessSnapshot as Snapshot, HarnessUi as Ui, HarnessView as View } from '../types'
import { formatTokens } from './lib/tokens'

export type PaneHandlers = {
  setView: (view: View, group?: string) => void
  select: (id: string) => void
  toggle: (id: string) => void
  disable: (item: Item) => void
  startEdit: (id: string | null) => void
  submitEdit: (item: Item, value: string) => void
  promptEdit: (item: Item) => void
  rebuild: () => void
}

export type PaneModel = { inventory: Inventory | null; snapshot: Snapshot | null; ui: Ui; home: string }

/** Une vue du pane : son onglet, sa touche (pane focalisé), les groupes qu'elle montre, une ligne d'aide. */
export type ViewSpec = { id: View; label: string; hotkey: string; groups: readonly string[]; blurb: string }

export const VIEWS: readonly ViewSpec[] = [
  { id: 'overview', label: 'Résumé', hotkey: '1', groups: [], blurb: 'Poids et comptes par source ; un clic ouvre la vue.' },
  { id: 'instructions', label: 'Instructions', hotkey: '2', groups: ['claudeMd', 'memory'], blurb: 'CLAUDE.md, règles et mémoire : retirer ou éditer une puce, un paragraphe, un fichier.' },
  { id: 'config', label: 'Réglages', hotkey: '3', groups: ['settings', 'hooks', 'plugins'], blurb: 'settings.json, hooks et plugins : retirer une clé ou une entrée, couper un plugin.' },
  { id: 'skills', label: 'Skills', hotkey: '4', groups: ['skills'], blurb: 'Skills, commandes et agents listés au modèle : déplacer un skill perso, couper un plugin, pointeurs claude.ai.' },
  { id: 'mcp', label: 'MCP & outils', hotkey: '5', groups: ['mcp', 'surface'], blurb: 'Serveurs MCP, outils et commandes : lecture seule, pointeur vers l’endroit où couper.' },
  { id: 'engine', label: 'Moteur', hotkey: '6', groups: ['engine', 'app', 'reminders'], blurb: 'Ce que toute session reçoit (vanilla) et les reminders observés dans ce processus.' },
  { id: 'journal', label: 'Journal', hotkey: '7', groups: [], blurb: 'Les actions du mod à la source, la plus récente en bas. Pas de restauration automatique.' },
]

/** La vue qui montre un groupe ; `overview` pour un groupe inconnu. */
export const viewOf = (groupId: string): View => VIEWS.find(v => v.groups.includes(groupId))?.id ?? 'overview'

const fold = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

/** La vue nommée par l'argument de `/harness` (`journal`, `3`, `régl`…), ou null quand il n'en nomme aucune. */
export const viewFromArg = (arg: string): View | null => {
  const a = fold(arg)
  if (!a) return null
  return VIEWS.find(v => v.id === a || v.hotkey === a || fold(v.label).startsWith(a))?.id ?? null
}

type Row = { item: Item; depth: number; hasChildren: boolean }

const flatten = (items: Item[], expanded: Record<string, boolean>, depth = 0): Row[] =>
  items.flatMap(item => {
    const hasChildren = (item.children?.length ?? 0) > 0
    const row: Row = { item, depth, hasChildren }
    return hasChildren && expanded[item.id] ? [row, ...flatten(item.children!, expanded, depth + 1)] : [row]
  })

const find = (items: Item[], id: string): Item | null => {
  for (const i of items) {
    if (i.id === id) return i
    const inChildren = i.children ? find(i.children, id) : null
    if (inChildren) return inChildren
  }
  return null
}

const leaves = (items: Item[]): Item[] => items.flatMap(i => (i.children?.length ? leaves(i.children) : [i]))

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

const short = (path: string, home: string) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path)

export const remindersGroup = (snap: Snapshot | null): Item => {
  const children: Item[] = (snap?.attachments ?? []).map((a, n) => ({
    id: `reminders/${a.type}#${n}`,
    group: 'reminders',
    title: `${a.type}${a.origin === 'engine' ? '' : ` (${a.origin}${a.event ? ` ${a.event}` : ''})`}`,
    text: a.text,
    tokens: Math.ceil(a.text.length / 3.5),
    vanilla: a.origin === 'engine',
    source: a.origin === 'engine' ? { kind: 'engine' } : a.origin === 'plugin' ? { kind: 'plugin', name: a.event ?? '?' } : { kind: 'unknown' },
    hint: a.origin === 'engine' ? undefined : a.origin === 'hook' ? `Texte produit par un hook settings/plugin (${a.event ?? '?'}) : à couper dans le groupe Hooks.` : 'Texte attaché par un plugin : à couper avec le plugin.',
    badges: [a.origin, 'observé dans ce processus'],
  }))
  return {
    id: 'reminders', group: 'reminders', title: 'Reminders observés', text: '', vanilla: children.every(c => c.vanilla),
    tokens: children.reduce((n, c) => n + c.tokens, 0), source: { kind: 'unknown' }, children,
  }
}

export const allGroups = (model: PaneModel): Item[] => {
  const groups = model.inventory?.groups ?? []
  const surfaceAt = groups.findIndex(g => g.id === 'surface')
  const reminders = remindersGroup(model.snapshot)
  return surfaceAt < 0 ? [...groups, reminders] : [...groups.slice(0, surfaceAt), reminders, ...groups.slice(surfaceAt)]
}

export const findItem = (model: PaneModel, id: string): Item | null => find(allGroups(model), id)

const sourceLine = (item: Item, home: string): string => {
  const s = item.source
  switch (s.kind) {
    case 'engine': return 'source : moteur'
    case 'builtin': return `source : plugin intégré ${s.plugin}`
    case 'file': return `fichier ${s.tier}`
    case 'settings': return `settings › ${s.keyPath.join('.')}`
    case 'plugin': return `plugin ${s.name}${s.root ? ` · ${short(s.root, home)}` : ''}`
    case 'mcp': return `serveur MCP ${s.server}`
    case 'claude-ai': return `claude.ai · ${s.what}`
    default: return 'source inconnue'
  }
}

const sourcePath = (item: Item): string | null =>
  item.source.kind === 'file' ? item.source.path : item.source.kind === 'settings' ? item.source.path : item.source.kind === 'plugin' && item.source.root ? item.source.root : null

/** Les tables d'éléments des surfaces qui dessinent le pane en entier (la mobile n'a pas d'Input). */
export type PaneElements = Elements['terminal'] | Elements['desktop'] | Elements['vscode']

export const renderPane = (els: PaneElements, e: Extract<RenderInput, { component: 'Pane' }>, model: PaneModel, act: PaneHandlers) => {
  const { Box, Text, Button, Input, Link, Code, Markdown } = els
  const width = e.props.bodyColumns
  // un pane inline (terminal sur l'écran principal) est étroit : l'arbre et le détail s'empilent
  const narrow = width < 80
  const leftWidth = narrow ? width : Math.max(28, Math.min(44, Math.floor(width * 0.38)))
  const rightWidth = narrow ? width : Math.max(20, width - leftWidth - 3)
  const groups = allGroups(model)
  const view = VIEWS.find(v => v.id === model.ui.view) ?? VIEWS[0]!
  const shown = groups.filter(g => view.groups.includes(g.id))
  const rows = flatten(shown, model.ui.expanded)
  const selected = model.ui.selected ? find(shown, model.ui.selected) : null
  const inv = model.inventory

  const header = inv
    ? `${inv.count} instruction${inv.count > 1 ? 's' : ''} non-vanilla · ${formatTokens(inv.tokens)} tok${inv.observedClaudeMd ? '' : ' · CLAUDE.md reconstruit'}`
    : 'Inventaire en construction…'

  const badgeLine = (item: Item) =>
    [item.vanilla ? 'vanilla' : 'non-vanilla', sourceLine(item, model.home), `${formatTokens(item.tokens)} tok`, ...(item.badges ?? [])]
      .concat(model.ui.pending.includes(item.id) ? ['retiré de la source · le contexte le garde jusqu’à relecture par le moteur'] : [])
      .concat(sourcePath(item) && model.ui.changedOutside.includes(sourcePath(item)!) ? ['modifié hors du mod'] : [])
      .join(' · ')

  const nav = (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
      {VIEWS.map(v =>
        v.id === view.id ? (
          <Button key={`view:${v.id}`} variant="primary" hotkey={v.hotkey} onPress={() => act.setView(v.id)}>{v.label}</Button>
        ) : (
          <Button key={`view:${v.id}`} plain dimColor hotkey={v.hotkey} onPress={() => act.setView(v.id)}>{v.label}</Button>
        ),
      )}
    </Box>
  )

  const rebuildButton = <Button key="rebuild" plain dimColor onPress={() => act.rebuild()}>↻ relire le disque</Button>

  const overview = () => {
    const barWidth = Math.max(8, Math.min(30, Math.floor(width / 4)))
    const max = Math.max(1, ...groups.map(g => g.tokens))
    const labelWidth = narrow ? width - 2 : Math.max(16, width - barWidth - 34)
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="wrap">{view.blurb}</Text>
        <Box flexDirection="column" marginTop={1}>
          {groups.map(g => {
            const nonVanilla = leaves([g]).filter(i => !i.vanilla).length
            const bar = '█'.repeat(Math.round((g.tokens / max) * barWidth)).padEnd(barWidth, '·')
            const stats = `${formatTokens(g.tokens)} tok · ${nonVanilla} non-vanilla`
            return (
              <Box key={`ov:${g.id}`} flexDirection={narrow ? 'column' : 'row'} columnGap={1}>
                <Button key={`go:${g.id}`} plain dimColor={g.vanilla} onPress={() => act.setView(viewOf(g.id), g.id)}>
                  {narrow ? cut(g.title, labelWidth) : cut(g.title, labelWidth).padEnd(labelWidth)}
                </Button>
                <Text dimColor={g.vanilla}>{bar}</Text>
                <Text dimColor>{stats}</Text>
              </Box>
            )
          })}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {inv && <Text dimColor wrap="wrap">{`${inv.observedClaudeMd ? 'CLAUDE.md observé via prompt.context' : 'CLAUDE.md reconstruit depuis le disque'} · inventaire du ${inv.builtAt}`}</Text>}
          {model.ui.changedOutside.length > 0 && <Text color="yellow" wrap="wrap">{`${model.ui.changedOutside.length} source(s) modifiée(s) hors du mod : relire le disque.`}</Text>}
          {rebuildButton}
        </Box>
      </Box>
    )
  }

  const journal = () => (
    <Box flexDirection="column">
      <Text dimColor wrap="wrap">{view.blurb}</Text>
      <Link href={`file://${model.home}/.claude/harness/journal.md`} label="~/.claude/harness/journal.md" />
      <Box marginTop={1}>
        <Markdown text={inv?.journal ?? '(aucune action consignée)'} />
      </Box>
    </Box>
  )

  const tree = (
    <Box flexDirection="column" width={leftWidth} marginRight={narrow ? 0 : 1}>
      <Text dimColor wrap="wrap">{view.blurb}</Text>
      {rows.length === 0 && <Text dimColor>Rien à afficher.</Text>}
      {rows.map(({ item, depth, hasChildren }) => {
        const isSelected = model.ui.selected === item.id
        const marker = hasChildren ? (model.ui.expanded[item.id] ? '▾ ' : '▸ ') : '· '
        const count = hasChildren && !model.ui.expanded[item.id] ? ` (${item.children!.length})` : ''
        const label = cut(`${'  '.repeat(depth)}${marker}${item.title}${count}`, leftWidth - 2)
        return (
          <Box key={`row:${item.id}`}>
            <Button
              key={`sel:${item.id}`}
              plain
              dimColor={item.vanilla && !isSelected}
              variant={isSelected ? 'primary' : undefined}
              onPress={() => {
                if (hasChildren) act.toggle(item.id)
                act.select(item.id)
              }}
            >
              {label}
            </Button>
          </Box>
        )
      })}
      <Box marginTop={1}>{rebuildButton}</Box>
    </Box>
  )

  const detail = (
    <Box flexDirection="column" width={rightWidth} borderStyle="single" borderDimColor paddingX={1} marginTop={narrow ? 1 : 0}>
      {!selected && <Text dimColor wrap="wrap">Sélectionne un élément dans l’arbre. Les groupes vanilla sont ce que toute session reçoit ; le reste vient de ta configuration.</Text>}
      {selected && (
        <Box flexDirection="column">
          <Text bold wrap="wrap">{selected.title}</Text>
          <Text dimColor wrap="wrap">{badgeLine(selected)}</Text>
          {sourcePath(selected) && <Link href={`file://${sourcePath(selected)}`} label={short(sourcePath(selected)!, model.home)} />}
          <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
            {selected.disable && (
              <Button
                key={`disable:${selected.id}`}
                variant={model.ui.confirming === selected.id ? 'primary' : 'secondary'}
                onPress={() => act.disable(selected)}
              >
                {model.ui.confirming === selected.id ? 'Confirmer la suppression du fichier' : selected.disable.kind === 'remove-file' ? 'Supprimer le fichier' : selected.disable.kind === 'disable-plugin' ? 'Désactiver le plugin' : selected.disable.kind === 'disable-skill' ? 'Désactiver le skill' : 'Désactiver'}
              </Button>
            )}
            {selected.edit === 'inline' && model.ui.editing !== selected.id && (
              <Button key={`edit:${selected.id}`} variant="secondary" onPress={() => act.startEdit(selected.id)}>Modifier</Button>
            )}
            {selected.edit === 'prompt' && (
              <Button key={`prompt:${selected.id}`} variant="secondary" onPress={() => act.promptEdit(selected)}>Modifier via Claude</Button>
            )}
            {!selected.disable && !selected.edit && selected.children === undefined && (
              <Text dimColor wrap="wrap">{selected.hint ?? (selected.vanilla ? 'Vanilla : rien à couper ici.' : 'Pas d’action à la source pour cet élément.')}</Text>
            )}
          </Box>
          {selected.hint && (selected.disable || selected.edit) && <Text dimColor wrap="wrap">{selected.hint}</Text>}
          {model.ui.editing === selected.id && (
            <Box marginTop={1}>
              <Input
                key={`input:${selected.id}`}
                value={selected.source.kind === 'settings' ? selected.text.replace(/^"|"$/g, '') : selected.text.replace(/^(\s*)([-*+]|\d+[.)])\s+/, '')}
                submitLabel="enregistrer"
                autoFocus
                onSubmit={value => act.submitEdit(selected, value)}
              />
              <Button key={`cancel:${selected.id}`} plain dimColor onPress={() => act.startEdit(null)}>annuler</Button>
            </Box>
          )}
          <Box marginTop={1}>
            {selected.children && selected.children.length > 0 && selected.text === '' ? (
              <Text dimColor>{selected.children.length} élément{selected.children.length > 1 ? 's' : ''} · {formatTokens(selected.tokens)} tok</Text>
            ) : (
              <Code source={selected.text || '(vide)'} language={selected.source.kind === 'settings' ? 'json' : 'markdown'} wrap="wrap" />
            )}
          </Box>
        </Box>
      )}
    </Box>
  )

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" flexWrap="wrap" columnGap={1}>
        <Text bold>Harnais</Text>
        <Text dimColor wrap="truncate-end">{header}</Text>
      </Box>
      {nav}
      {model.ui.notice && <Text color="yellow" wrap="wrap">{model.ui.notice}</Text>}
      <Box marginTop={1}>
        {view.id === 'overview' ? overview() : view.id === 'journal' ? journal() : (
          <Box flexDirection={narrow ? 'column' : 'row'}>
            {tree}
            {detail}
          </Box>
        )}
      </Box>
    </Box>
  )
}
