// Le module de hooks du mod `harness` : capture passive de ce que le moteur envoie,
// inventaire disque, pane « Harnais », commande /harness, actions à la source, veille mtime.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HarnessInventory, HarnessItem, HarnessSnapshot, HarnessUi } from '../types'
import { fillPromptForEdit, runDisable, runInlineEdit, type ActionEnv, type Invalidation } from './lib/actions'
import { buildInventory } from './lib/inventory'
import { formatTokens } from './lib/tokens'
import { findItem, renderPane, type PaneModel } from './pane'

const PANE = 'harness'
const WATCH_MS = 5000

const emptySnapshot = (): HarnessSnapshot => ({ at: '', sections: [], outputStyle: null, blocks: [], instructionFiles: [], attachments: [], skillPrompts: [] })
const emptyUi = (): HarnessUi => ({ selected: null, expanded: { claudeMd: true }, confirming: null, editing: null, pending: [], changedOutside: [], notice: null })

const snapshotAtom = atom({ plugin: 'harness', key: 'snapshot' } as const, null)
const inventoryAtom = atom({ plugin: 'harness', key: 'inventory' } as const, null)
const uiAtom = atom({ plugin: 'harness', key: 'ui' } as const, emptyUi())

const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

export const register: Register = on => {
  // Variables de module : perdues au reload, ce qui est voulu (caches).
  let home = ''
  let cwd = ''
  let root = ''
  let lastSectionsHash = ''
  let building: Promise<void> | null = null
  const mtimes = new Map<string, number>()
  let watch: { cancel: () => void } | null = null

  const iso = async ($: EngineInterface) => new Date(await $.clock.now()).toISOString()
  const actionEnv = ($: EngineInterface): ActionEnv => ({ home, root, now: () => iso($) })

  const ensureEnv = async ($: EngineInterface) => {
    if (!home) home = (await $.env.get('HOME')) ?? ''
    if (!cwd) cwd = await $.session.cwd()
    if (!root) root = (await $.session.root().catch(() => cwd)) || cwd
  }

  const status = ($: EngineInterface, inv: HarnessInventory | null) =>
    $.ui.status(inv ? `harness: ${inv.count} instr · ${formatTokens(inv.tokens)} tok` : 'harness: …')

  const snap = async ($: EngineInterface) => (await read($, snapshotAtom)) ?? emptySnapshot()

  const rebuild = async ($: EngineInterface, reason: string) => {
    if (building) return building
    building = (async () => {
      try {
        await ensureEnv($)
        const current = await snap($)
        const inv = await buildInventory($, current, { home, cwd, root, now: await iso($) })
        await update($, inventoryAtom, () => inv)
        for (const path of inv.watched) {
          try {
            mtimes.set(path, (await $.fs.stat(path)).mtimeMs)
          } catch {
            mtimes.delete(path)
          }
        }
        status($, inv)
        $.ui.log(`harness: inventaire reconstruit (${reason}) : ${inv.count} instr, ${inv.tokens} tok`, { to: 'debug' })
      } catch (err) {
        $.ui.log(`harness: inventaire en échec (${reason}) : ${String(err)}`, { to: 'debug' })
      } finally {
        building = null
      }
    })()
    return building
  }

  const invalidate = ($: EngineInterface, what: Invalidation[]) => {
    for (const ev of new Set(what)) $.ui.invalidate(ev)
  }

  // ---------- capture passive ----------

  on('session.start', async ($, e, next) => {
    await ensureEnv($)
    await $.command.register({ name: 'harness', description: 'Harnais : tout ce qui entre dans le contexte, et où le couper à la source' })
    const started = await next(e)
    // Première capture sans attendre un tour : les sections telles que le moteur les composerait maintenant.
    try {
      const composed = await $.prompt.compose()
      const sections = composed.sections.map(s => ({ id: s.id, text: s.text, scope: s.scope }))
      lastSectionsHash = hash(sections.map(s => `${s.id}\u0000${s.text}`).join('\u0001'))
      const current = await snap($)
      await update($, snapshotAtom, () => ({ ...current, at: '', sections }))
    } catch (err) {
      $.ui.log(`harness: $.prompt.compose a échoué : ${String(err)}`, { to: 'debug' })
    }
    await rebuild($, 'session.start')
    watch?.cancel()
    watch = $.clock.every(WATCH_MS, async () => {
      try {
        const panes = await $.ui.panes()
        if (!panes.some(p => p.id === PANE && p.isShown)) return
        const changed: string[] = []
        for (const [path, known] of mtimes) {
          try {
            const now = (await $.fs.stat(path)).mtimeMs
            if (now !== known) changed.push(path)
          } catch {
            changed.push(path)
          }
        }
        if (changed.length === 0) return
        await update($, uiAtom, u => ({ ...u, changedOutside: [...new Set([...u.changedOutside, ...changed])] }))
        await rebuild($, 'veille mtime')
      } catch {
        // la veille ne doit jamais faire de bruit
      }
    })
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const sections = result.sections.map(s => ({ id: s.id, text: s.text, scope: s.scope }))
    const h = hash(sections.map(s => `${s.id}\u0000${s.text}`).join('\u0001'))
    if (h !== lastSectionsHash) {
      lastSectionsHash = h
      const current = await snap($)
      const at = await iso($)
      const outputStyle = e.outputStyle?.name ?? null
      await update($, snapshotAtom, () => ({ ...current, at, sections, outputStyle }))
    }
    return result
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const current = await snap($)
    await update($, snapshotAtom, () => ({
      ...current,
      blocks: result.blocks.map(b => ({ name: b.name, text: b.text })),
      instructionFiles: (result.instructionFiles ?? e.instructionFiles ?? []).map(f => ({ path: f.path, kind: f.kind, content: f.content, ...(f.parent ? { parent: f.parent } : {}) })),
    }))
    return result
  })

  on('prompt.attachment', async ($, e, next) => {
    const result = await next(e)
    if (result.text === null) return result
    const origin = e.origin.kind
    const event = e.origin.kind === 'engine' ? undefined : e.origin.event
    const current = await snap($)
    const key = `${e.type}\u0000${hash(result.text)}`
    if (!current.attachments.some(a => `${a.type}\u0000${hash(a.text)}` === key)) {
      await update($, snapshotAtom, () => ({ ...current, attachments: [...current.attachments, { type: e.type, text: result.text ?? '', origin, ...(event ? { event } : {}) }].slice(-100) }))
    }
    return result
  })

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    const current = await snap($)
    const at = await iso($)
    await update($, snapshotAtom, () => ({ ...current, skillPrompts: [...current.skillPrompts.filter(s => s.skill !== e.skill), { skill: e.skill, text: result.text, at }] }))
    return result
  })

  on('turn.start', async ($, e, next) => {
    const current = await snap($)
    await update($, snapshotAtom, () => ({ ...current, attachments: [] }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await update($, uiAtom, u => ({ ...u, pending: [], confirming: null }))
    await rebuild($, 'turn.complete')
    return result
  })

  // ---------- commande et pane ----------

  on('command.run', { command: 'harness' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Harnais', focus: true, columns: 120 })
    void rebuild($, '/harness')
    return { text: 'Pane Harnais ouvert.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const model: PaneModel = { inventory: await read($, inventoryAtom), snapshot: await read($, snapshotAtom), ui: await read($, uiAtom), home }
    const setNotice = (notice: string | null) => update($, uiAtom, u => ({ ...u, notice }))
    const after = async (res: { ok: boolean; notice: string; invalidate: Invalidation[]; removedFile?: string }, item: HarnessItem) => {
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
    return renderPane($, e, model, {
      select: id => void update($, uiAtom, u => ({ ...u, selected: id, confirming: u.confirming === id ? u.confirming : null, editing: null })),
      toggle: id => void update($, uiAtom, u => ({ ...u, expanded: { ...u.expanded, [id]: !u.expanded[id] } })),
      startEdit: id => void update($, uiAtom, u => ({ ...u, editing: id, confirming: null })),
      rebuild: () => void rebuild($, 'bouton'),
      disable: item => {
        void (async () => {
          const d = item.disable
          if (!d) return setNotice(item.hint ?? 'Rien à couper.')
          if (d.kind === 'remove-file' && model.ui.confirming !== item.id) {
            return update($, uiAtom, u => ({ ...u, confirming: item.id, notice: 'Second clic pour confirmer la suppression du fichier entier.' }))
          }
          const fresh = findItem(model, item.id) ?? item
          await after(await runDisable($, actionEnv($), fresh), fresh)
        })()
      },
      submitEdit: (item, value) => {
        void (async () => {
          await after(await runInlineEdit($, actionEnv($), item, value), item)
        })()
      },
      promptEdit: item => {
        void (async () => {
          const res = await fillPromptForEdit($, item)
          await setNotice(res.notice)
        })()
      },
    })
  })
}
