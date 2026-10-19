// Le rendu du pane « Harnais » : arbre à gauche, détail à droite. Pur : reçoit l'état et des handlers.
import type { Elements, RenderInput } from 'claude-code'

import type { HarnessInventory as Inventory, HarnessItem as Item, HarnessSnapshot as Snapshot, HarnessUi as Ui } from '../types'
import { formatTokens } from './lib/tokens'

export type PaneHandlers = {
  select: (id: string) => void
  toggle: (id: string) => void
  disable: (item: Item) => void
  startEdit: (id: string | null) => void
  submitEdit: (item: Item, value: string) => void
  promptEdit: (item: Item) => void
  rebuild: () => void
}

export type PaneModel = { inventory: Inventory | null; snapshot: Snapshot | null; ui: Ui; home: string }

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
    badges: [a.origin, 'ce tour'],
  }))
  return {
    id: 'reminders', group: 'reminders', title: 'Reminders du tour', text: '', vanilla: children.every(c => c.vanilla),
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
  const { Box, Text, Button, Input, Link, Code } = els
  const width = e.props.bodyColumns
  const leftWidth = Math.max(28, Math.min(44, Math.floor(width * 0.38)))
  const rightWidth = Math.max(20, width - leftWidth - 3)
  const groups = allGroups(model)
  const rows = flatten(groups, model.ui.expanded)
  const selected = model.ui.selected ? find(groups, model.ui.selected) : null
  const inv = model.inventory

  const header = inv
    ? `${inv.count} instruction${inv.count > 1 ? 's' : ''} non-vanilla · ${formatTokens(inv.tokens)} tok${inv.observedClaudeMd ? '' : ' · CLAUDE.md reconstruit depuis le disque'}`
    : 'Inventaire en construction…'

  const badgeLine = (item: Item) =>
    [item.vanilla ? 'vanilla' : 'non-vanilla', sourceLine(item, model.home), `${formatTokens(item.tokens)} tok`, ...(item.badges ?? [])]
      .concat(model.ui.pending.includes(item.id) ? ['retiré · en attente du prochain tour'] : [])
      .concat(sourcePath(item) && model.ui.changedOutside.includes(sourcePath(item)!) ? ['modifié hors du mod'] : [])
      .join(' · ')

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold>Harnais</Text>
        <Text dimColor>{header}</Text>
      </Box>
      {model.ui.notice && <Text color="yellow">{model.ui.notice}</Text>}
      <Box flexDirection="row" marginTop={1}>
        <Box flexDirection="column" width={leftWidth} marginRight={1}>
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
          <Box marginTop={1}>
            <Button key="rebuild" plain dimColor onPress={() => act.rebuild()}>↻ relire le disque</Button>
          </Box>
        </Box>
        <Box flexDirection="column" width={rightWidth} borderStyle="single" borderDimColor paddingX={1}>
          {!selected && <Text dimColor>Sélectionne un élément à gauche. Les groupes vanilla sont ce que toute session reçoit ; le reste vient de ta configuration.</Text>}
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
      </Box>
    </Box>
  )
}
