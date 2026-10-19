// Le module de hooks du mod `harness` : capture passive de ce que le moteur envoie,
// inventaire disque, pane « Harnais », commande /harness, actions à la source, veille mtime.
// Les fonctions qui reçoivent `$` sont déclarées au niveau du module : le validateur les suit.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HarnessInventory, HarnessItem, HarnessSnapshot, HarnessUi } from '../types'
import { fillPromptForEdit, runDisable, runInlineEdit, type ActionEnv, type ActionIo, type ActionResult, type Invalidation } from './lib/actions'
import { buildInventory, type InventoryIo } from './lib/inventory'
import { formatTokens } from './lib/tokens'
import { VIEWS, findItem, renderPane, viewFromArg, type PaneModel } from './pane'

const PANE = 'harness'
const WATCH_MS = 5000

const emptySnapshot = (): HarnessSnapshot => ({ at: '', sections: [], outputStyle: null, blocks: [], instructionFiles: [], attachments: [], skillPrompts: [] })
const emptyUi = (): HarnessUi => ({ view: 'overview', selected: null, expanded: { claudeMd: true }, confirming: null, editing: null, pending: [], changedOutside: [], notice: null })

const snapshotAtom = atom({ plugin: 'harness', key: 'snapshot' } as const, null)
const inventoryAtom = atom({ plugin: 'harness', key: 'inventory' } as const, null)
const uiAtom = atom({ plugin: 'harness', key: 'ui' } as const, emptyUi())

// État de module : perdu au reload, ce qui est voulu (caches et chemins).
const env = { home: '', cwd: '', root: '' }
const mtimes = new Map<string, number>()
let lastSectionsHash = ''
/** Une capture (sections, blocs, reminders, skill) est arrivée depuis la dernière reconstruction : la veille reconstruit au prochain tick. */
let dirty = false
let building: Promise<void> | null = null
let watch: { cancel: () => void } | null = null

const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

const iso = async ($: EngineInterface) => new Date(await $.clock.now()).toISOString()

const actionEnv = ($: EngineInterface): ActionEnv => ({ home: env.home, root: env.root, now: () => iso($) })

/** Lecture tolérante : null quand le fichier manque ou n'est pas du texte. */
const readText = async ($: EngineInterface, path: string): Promise<string | null> => {
  try {
    const out = await $.fs.read(path)
    return typeof out === 'string' ? out : null
  } catch {
    return null
  }
}

/** Les entrées-sorties de l'inventaire, autour de `$` ; les modules importés ne voient jamais `$`. */
const inventoryIo = ($: EngineInterface): InventoryIo => ({
  readText: path => readText($, path),
  list: async path => {
    try {
      return (await $.fs.list(path)).map(entry => entry.name)
    } catch {
      return []
    }
  },
  exists: async path => {
    try {
      return await $.fs.exists(path)
    } catch {
      return false
    }
  },
  pluginDirs: () => $.env.get('CLAUDE_CODE_PLUGIN_DIRS'),
  ancestors: names => $.fs.ancestors({ names }),
  commands: () => $.command.list(),
  tools: () => $.tool.list(),
  usage: async () => {
    try {
      return (await $.session.usage({ breakdown: 'summary' })).context.breakdown ?? null
    } catch {
      return null
    }
  },
})

/** Les entrées-sorties des actions, autour de `$`. */
const actionIo = ($: EngineInterface): ActionIo => ({
  readText: path => readText($, path),
  write: (path, text) => $.fs.write(path, text),
  run: async argv => {
    const out = await $.process.run(argv, { timeoutMs: 10_000 })
    return { exitCode: out.exitCode, stderr: out.stderr }
  },
  promptRead: async () => ({ text: (await $.prompt.read()).text }),
  promptFill: async args => ({ isFilled: (await $.prompt.fill(args)).isFilled }),
})

const ensureEnv = async ($: EngineInterface) => {
  if (!env.home) env.home = (await $.env.get('HOME')) ?? ''
  if (!env.cwd) env.cwd = await $.session.cwd()
  if (!env.root) env.root = (await $.session.root().catch(() => env.cwd)) || env.cwd
}

const showStatus = ($: EngineInterface, inv: HarnessInventory | null) =>
  $.ui.status(inv ? `harness: ${inv.count} instr · ${formatTokens(inv.tokens)} tok` : 'harness: …')

const currentSnapshot = async ($: EngineInterface) => (await read($, snapshotAtom)) ?? emptySnapshot()

const rebuild = async ($: EngineInterface, reason: string): Promise<void> => {
  if (building) return building
  building = (async () => {
    try {
      await ensureEnv($)
      const snap = await currentSnapshot($)
      const inv = await buildInventory(inventoryIo($), snap, { home: env.home, cwd: env.cwd, root: env.root, now: await iso($) })
      await update($, inventoryAtom, () => inv)
      for (const path of inv.watched) {
        try {
          mtimes.set(path, (await $.fs.stat(path)).mtimeMs)
        } catch {
          mtimes.delete(path)
        }
      }
      showStatus($, inv)
      await exportInventory($, inv, snap)
      $.ui.log(`harness: inventaire reconstruit (${reason}) : ${inv.count} instr, ${inv.tokens} tok`, { to: 'debug' })
    } catch (err) {
      $.ui.log(`harness: inventaire en échec (${reason}) : ${String(err)}`, { to: 'debug' })
    } finally {
      building = null
    }
  })()
  return building
}

/** Projection lisible de l'inventaire, sans les textes : `~/.claude/harness/inventory.json`. Sert de vue machine et de preuve.
 *  Un seul fichier par `~/.claude` : la dernière session qui reconstruit l'emporte, d'où `sessionId` et `cwd`. */
const exportInventory = async ($: EngineInterface, inv: HarnessInventory, snap: HarnessSnapshot) => {
  let sessionId: string | null = null
  try {
    sessionId = await $.session.id()
  } catch {
    sessionId = null
  }
  const slim = (items: HarnessItem[]): unknown[] =>
    items.map(i => ({
      id: i.id,
      title: i.title,
      tokens: i.tokens,
      vanilla: i.vanilla,
      source: i.source,
      ...(i.disable ? { disable: i.disable.kind } : {}),
      ...(i.edit ? { edit: i.edit } : {}),
      ...(i.badges?.length ? { badges: i.badges } : {}),
      ...(i.children?.length ? { children: slim(i.children) } : {}),
    }))
  const out = {
    builtAt: inv.builtAt,
    sessionId,
    cwd: env.cwd,
    count: inv.count,
    tokens: inv.tokens,
    observedClaudeMd: inv.observedClaudeMd,
    sections: snap.sections.map(s => ({ id: s.id, scope: s.scope, chars: s.text.length })),
    blocks: snap.blocks.map(b => ({ name: b.name, chars: b.text.length })),
    instructionFiles: snap.instructionFiles.map(f => ({ path: f.path, kind: f.kind, ...(f.parent ? { parent: f.parent } : {}) })),
    attachments: snap.attachments.map(a => ({ type: a.type, origin: a.origin, ...(a.event ? { event: a.event } : {}), chars: a.text.length })),
    skillPrompts: snap.skillPrompts.map(s => s.skill),
    groups: slim(inv.groups),
  }
  try {
    await $.fs.write(`${env.home}/.claude/harness/inventory.json`, `${JSON.stringify(out, null, 2)}\n`)
  } catch (err) {
    $.ui.log(`harness: export inventory.json en échec : ${String(err)}`, { to: 'debug' })
  }
}

const invalidate = ($: EngineInterface, what: Invalidation[]) => {
  for (const ev of new Set(what)) $.ui.invalidate(ev)
}

/** Première capture sans attendre un tour : les sections telles que le moteur les composerait maintenant. */
const captureNow = async ($: EngineInterface) => {
  try {
    const composed = await $.prompt.compose()
    const sections = composed.sections.map(s => ({ id: s.id, text: s.text, scope: s.scope }))
    lastSectionsHash = hash(sections.map(s => `${s.id}\u0000${s.text}`).join('\u0001'))
    const snap = await currentSnapshot($)
    await update($, snapshotAtom, () => ({ ...snap, sections }))
  } catch (err) {
    $.ui.log(`harness: $.prompt.compose a échoué : ${String(err)}`, { to: 'debug' })
  }
}

/** La veille : reconstruit dès qu'une capture est arrivée ; tant que le pane est affiché, relit aussi le disque quand un mtime bouge. */
const tick = async ($: EngineInterface) => {
  try {
    if (dirty) {
      dirty = false
      await rebuild($, 'capture')
    }
    const panes = await $.ui.panes()
    if (!panes.some(p => p.id === PANE && p.isShown)) return
    const changed: string[] = []
    for (const [path, known] of mtimes) {
      try {
        if ((await $.fs.stat(path)).mtimeMs !== known) changed.push(path)
      } catch {
        changed.push(path)
      }
    }
    if (changed.length === 0) return
    await update($, uiAtom, u => ({ ...u, changedOutside: [...new Set([...u.changedOutside, ...changed])] }))
    await rebuild($, 'veille mtime')
  } catch {
    // la veille ne fait jamais de bruit
  }
}

const afterAction = async ($: EngineInterface, res: ActionResult, item: HarnessItem) => {
  await update($, uiAtom, u => ({
    ...u,
    notice: res.notice,
    confirming: null,
    editing: null,
    pending: res.ok ? [...u.pending, item.id] : u.pending,
    selected: res.removedFile ? null : u.selected,
  }))
  if (res.ok) {
    invalidate($, res.invalidate)
    $.ui.toast(res.notice)
    await rebuild($, 'action')
  }
}

const disableItem = async ($: EngineInterface, model: PaneModel, item: HarnessItem) => {
  const d = item.disable
  if (!d) return update($, uiAtom, u => ({ ...u, notice: item.hint ?? 'Rien à couper.' }))
  if (d.kind === 'remove-file' && model.ui.confirming !== item.id) {
    return update($, uiAtom, u => ({ ...u, confirming: item.id, notice: 'Second clic pour confirmer la suppression du fichier entier.' }))
  }
  const fresh = findItem(model, item.id) ?? item
  await afterAction($, await runDisable(actionIo($), actionEnv($), fresh), fresh)
}

const editInline = async ($: EngineInterface, item: HarnessItem, value: string) => {
  await afterAction($, await runInlineEdit(actionIo($), actionEnv($), item, value), item)
}

const editViaPrompt = async ($: EngineInterface, item: HarnessItem) => {
  const res = await fillPromptForEdit(actionIo($), item)
  await update($, uiAtom, u => ({ ...u, notice: res.notice }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await ensureEnv($)
    await $.command.register({ name: 'harness', description: 'Harnais : tout ce qui entre dans le contexte, et où le couper à la source', argumentHint: '[résumé|instructions|réglages|skills|mcp|moteur|journal]', immediate: true })
    const started = await next(e)
    await captureNow($)
    await rebuild($, 'session.start')
    watch?.cancel()
    watch = $.clock.every(WATCH_MS, () => void tick($))
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const sections = result.sections.map(s => ({ id: s.id, text: s.text, scope: s.scope }))
    const h = hash(sections.map(s => `${s.id}\u0000${s.text}`).join('\u0001'))
    if (h !== lastSectionsHash) {
      lastSectionsHash = h
      const snap = await currentSnapshot($)
      const at = await iso($)
      const outputStyle = e.outputStyle?.name ?? null
      await update($, snapshotAtom, () => ({ ...snap, at, sections, outputStyle }))
      dirty = true
    }
    return result
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const snap = await currentSnapshot($)
    const files = (result.instructionFiles ?? e.instructionFiles ?? []).map(f => ({ path: f.path, kind: f.kind, content: f.content, ...(f.parent ? { parent: f.parent } : {}) }))
    const blocks = result.blocks.map(b => ({ name: b.name, text: b.text }))
    await update($, snapshotAtom, () => ({ ...snap, blocks, instructionFiles: files }))
    dirty = true
    return result
  })

  // Le moteur ne redemande la plupart des attachments qu'une fois par processus : on garde tout ce qui a été vu,
  // dédoublonné par type et texte, le plus récent en dernier.
  on('prompt.attachment', async ($, e, next) => {
    const result = await next(e)
    if (result.text === null) return result
    const text = result.text
    const origin = e.origin.kind
    const event = e.origin.kind === 'engine' ? undefined : e.origin.event
    const snap = await currentSnapshot($)
    const key = `${e.type}\u0000${hash(text)}`
    const kept = snap.attachments.filter(a => `${a.type}\u0000${hash(a.text)}` !== key)
    const attachments = [...kept, { type: e.type, text, origin, ...(event ? { event } : {}) }].slice(-100)
    await update($, snapshotAtom, () => ({ ...snap, attachments }))
    dirty = true
    return result
  })

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    const snap = await currentSnapshot($)
    const at = await iso($)
    const skillPrompts = [...snap.skillPrompts.filter(s => s.skill !== e.skill), { skill: e.skill, text: result.text, at }]
    await update($, snapshotAtom, () => ({ ...snap, skillPrompts }))
    dirty = true
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await update($, uiAtom, u => ({ ...u, pending: [], confirming: null }))
    await rebuild($, 'turn.complete')
    return result
  })

  on('command.run', { command: 'harness' }, async ($, e) => {
    const view = viewFromArg(e.args)
    if (view) await update($, uiAtom, u => ({ ...u, view, selected: null, editing: null, confirming: null }))
    await $.ui.open({ id: PANE, title: 'Harnais', focus: true, columns: 120 })
    void rebuild($, '/harness')
    const label = VIEWS.find(v => v.id === view)?.label
    return { text: label ? `Pane Harnais ouvert, vue ${label}.` : 'Pane Harnais ouvert.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text dimColor>Le pane Harnais se lit sur le bureau ou dans un terminal.</Text>
        </Box>
      )
    }
    const model: PaneModel = { inventory: await read($, inventoryAtom), snapshot: await read($, snapshotAtom), ui: await read($, uiAtom), home: env.home }
    return renderPane($.ui.resolve(e), e, model, {
      setView: (view, group) => void update($, uiAtom, u => ({ ...u, view, selected: null, editing: null, confirming: null, expanded: group ? { ...u.expanded, [group]: true } : u.expanded })),
      select: id => void update($, uiAtom, u => ({ ...u, selected: id, confirming: u.confirming === id ? u.confirming : null, editing: null })),
      toggle: id => void update($, uiAtom, u => ({ ...u, expanded: { ...u.expanded, [id]: !u.expanded[id] } })),
      startEdit: id => void update($, uiAtom, u => ({ ...u, editing: id, confirming: null })),
      rebuild: () => void rebuild($, 'bouton'),
      disable: item => void disableItem($, model, item),
      submitEdit: (item, value) => void editInline($, item, value),
      promptEdit: item => void editViaPrompt($, item),
    })
  })
}
