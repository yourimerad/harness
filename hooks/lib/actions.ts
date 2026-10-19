// Les actions à la source : suppression d'unité, de fichier, de clé settings, de hook,
// désactivation de plugin ou de skill, édition mono-ligne, pré-remplissage du composer.
// Chaque action écrit d'abord le journal, puis le fichier, puis dit quoi invalider.
import type { HarnessItem as Item } from '../../types'
import { formatEntry, type JournalEntry } from './journal'
import { parseUnits, removeUnit, replaceUnit } from './markdown'
import { getKey, removeKey, setKey } from './settings'

export type Invalidation = 'prompt.context' | 'prompt.section'
export type ActionResult = { ok: boolean; notice: string; invalidate: Invalidation[]; removedFile?: string }

export type ActionEnv = { home: string; root: string; now: () => Promise<string> }

/** Les entrées-sorties des actions ; construites dans le module de hooks autour de `$`. */
export type ActionIo = {
  readText: (path: string) => Promise<string | null>
  write: (path: string, text: string) => Promise<void>
  run: (argv: string[]) => Promise<{ exitCode: number; stderr: string }>
  promptRead: () => Promise<{ text: string }>
  promptFill: (args: { text: string; mode: 'replace' | 'append' }) => Promise<{ isFilled: boolean }>
}

const journalPath = (env: ActionEnv) => `${env.home}/.claude/harness/journal.md`

/** Hors périmètre : tout ce qui vit sous plugins/ (cache, synced, marketplaces) et la source d'un plugin. */
export const isWritable = (path: string, env: ActionEnv): boolean => {
  if (!path.startsWith('/')) return false
  if (path.includes('/..')) return false
  if (path.startsWith(`${env.home}/.claude/plugins/`)) return false
  if (path.startsWith(`${env.home}/.claude/dev-mods/`)) return false
  return true
}

export const appendJournal = async (io: ActionIo, env: ActionEnv, entry: Omit<JournalEntry, 'at'>): Promise<void> => {
  const at = await env.now()
  const path = journalPath(env)
  const existing = (await io.readText(path)) ?? '# Journal harness\n\nChaque action du mod à la source, la plus récente en bas. Aucune restauration automatique : reconstruire à la main si besoin.\n\n'
  await io.write(path, `${existing.replace(/\n*$/, '\n\n')}${formatEntry({ at, ...entry })}`)
}

const removeFile = async (io: ActionIo, path: string): Promise<boolean> => {
  try {
    const run = await io.run(['rm', '--', path])
    return run.exitCode === 0
  } catch {
    return false
  }
}

/** CLAUDE.md vit dans les blocs de contexte ; la mémoire dans une section ; le reste prend effet à la prochaine session. */
const invalidationsFor = (item: Item): Invalidation[] =>
  item.group === 'claudeMd' ? ['prompt.context'] : item.group === 'memory' ? ['prompt.section'] : []

/** Retire du fichier d'index (MEMORY.md) toute unité qui pointe le fichier `target`. */
const dropIndexLines = async (io: ActionIo, env: ActionEnv, indexPath: string, target: string): Promise<string> => {
  const text = await io.readText(indexPath)
  if (text === null) return ''
  const base = target.slice(target.lastIndexOf('/') + 1)
  let current: string | null = text
  let n = 0
  for (const u of parseUnits(text).units) {
    if (!u.text.includes(`](${base})`)) continue
    if (current === null) break
    const out = removeUnit(current, u.id)
    if (!out) continue
    current = out.text
    n += 1
  }
  if (n === 0) return ''
  if (current === null) {
    await appendJournal(io, env, { action: 'remove-file', target: indexPath, before: text, note: `index vidé par le retrait de ${base}` })
    await removeFile(io, indexPath)
    return ` ; index ${indexPath.slice(indexPath.lastIndexOf('/') + 1)} vidé et supprimé`
  }
  await appendJournal(io, env, { action: 'remove-unit', target: indexPath, before: text, after: current, note: `${n} ligne(s) d'index pointant ${base}` })
  await io.write(indexPath, current)
  return ` ; ${n} ligne(s) d'index retirée(s)`
}

const INVALID_JSON = (path: string): ActionResult => ({ ok: false, notice: `JSON illisible : ${path} (rien n'a été écrit).`, invalidate: [] })

export const runDisable = async (io: ActionIo, env: ActionEnv, item: Item): Promise<ActionResult> => {
  try {
    return await disableUnguarded(io, env, item)
  } catch (err) {
    return err instanceof SyntaxError && item.disable ? INVALID_JSON(item.disable.path) : { ok: false, notice: `Action en échec : ${String(err)}`, invalidate: [] }
  }
}

const disableUnguarded = async (io: ActionIo, env: ActionEnv, item: Item): Promise<ActionResult> => {
  const d = item.disable
  if (!d) return { ok: false, notice: item.hint ?? 'Aucune action à la source pour cet élément.', invalidate: [] }
  if (!isWritable(d.path, env)) return { ok: false, notice: `Hors périmètre d'écriture : ${d.path}`, invalidate: [] }
  const inv = invalidationsFor(item)

  if (d.kind === 'remove-unit' && d.unitId) {
    const text = await io.readText(d.path)
    if (text === null) return { ok: false, notice: `Fichier introuvable : ${d.path}`, invalidate: [] }
    const out = removeUnit(text, d.unitId)
    if (!out) return { ok: false, notice: 'Unité introuvable : le fichier a changé, relecture faite.', invalidate: [] }
    if (out.text === null) {
      await appendJournal(io, env, { action: 'remove-file', target: d.path, before: text, note: 'dernière unité retirée : fichier supprimé' })
      const gone = await removeFile(io, d.path)
      return { ok: gone, notice: gone ? `Dernière unité retirée : ${d.path} supprimé.` : `Suppression refusée : ${d.path}`, invalidate: inv, removedFile: gone ? d.path : undefined }
    }
    await appendJournal(io, env, { action: 'remove-unit', target: d.path, before: out.removed.text, note: out.removed.title })
    await io.write(d.path, out.text)
    return { ok: true, notice: `Retiré de ${d.path} : « ${out.removed.title} »`, invalidate: inv }
  }

  if (d.kind === 'remove-file') {
    const text = await io.readText(d.path)
    await appendJournal(io, env, { action: 'remove-file', target: d.path, before: text ?? '(fichier déjà absent)' })
    const gone = text === null ? true : await removeFile(io, d.path)
    let extra = ''
    if (gone && d.indexPath) extra = await dropIndexLines(io, env, d.indexPath, d.path)
    return { ok: gone, notice: gone ? `Supprimé : ${d.path}${extra}` : `Suppression refusée : ${d.path}`, invalidate: inv, removedFile: gone ? d.path : undefined }
  }

  if (d.kind === 'remove-key' && d.keyPath) {
    const json = await io.readText(d.path)
    if (json === null) return { ok: false, notice: `Fichier introuvable : ${d.path}`, invalidate: [] }
    const out = removeKey(json, d.keyPath)
    if (!out) return { ok: false, notice: `Clé absente : ${d.keyPath.join('.')}`, invalidate: [] }
    await appendJournal(io, env, { action: 'remove-key', target: `${d.path} › ${d.keyPath.join('.')}`, before: JSON.stringify(out.removed, null, 2) })
    await io.write(d.path, out.text)
    return { ok: true, notice: `Clé retirée : ${d.keyPath.join('.')} (effet à la prochaine session pour la plupart des clés).`, invalidate: inv }
  }

  if (d.kind === 'remove-hook' && d.keyPath) {
    const json = await io.readText(d.path)
    if (json === null) return { ok: false, notice: `Fichier introuvable : ${d.path}`, invalidate: [] }
    const out = removeKey(json, d.keyPath)
    if (!out) return { ok: false, notice: 'Hook absent : le fichier a changé.', invalidate: [] }
    let text = out.text
    const eventPath = d.keyPath.slice(0, 2)
    const remaining = getKey(text, eventPath)
    if (Array.isArray(remaining) && remaining.length === 0) text = removeKey(text, eventPath)?.text ?? text
    const hooks = getKey(text, ['hooks'])
    if (hooks && typeof hooks === 'object' && !Array.isArray(hooks) && Object.keys(hooks as object).length === 0) text = removeKey(text, ['hooks'])?.text ?? text
    await appendJournal(io, env, { action: 'remove-hook', target: `${d.path} › ${d.keyPath.join('.')}`, before: JSON.stringify(out.removed, null, 2) })
    await io.write(d.path, text)
    return { ok: true, notice: `Hook retiré : ${d.keyPath.join('.')} (effet à la prochaine session).`, invalidate: inv }
  }

  if (d.kind === 'disable-plugin' && d.plugin) {
    const json = (await io.readText(d.path)) ?? '{}\n'
    const text = setKey(json, ['enabledPlugins', d.plugin], false)
    await appendJournal(io, env, { action: 'disable-plugin', target: d.plugin, after: `enabledPlugins.${d.plugin} = false` })
    await io.write(d.path, text)
    return { ok: true, notice: `Plugin ${d.plugin} désactivé dans settings (effet au prochain /reload-plugins ou à la prochaine session).`, invalidate: inv }
  }

  if (d.kind === 'disable-skill') {
    const name = d.path.slice(d.path.lastIndexOf('/') + 1)
    const parent = d.path.slice(0, d.path.lastIndexOf('/'))
    const target = `${parent}.disabled/${name}`
    try {
      const mk = await io.run(['mkdir', '-p', `${parent}.disabled`])
      if (mk.exitCode !== 0) throw new Error(mk.stderr)
      const mv = await io.run(['mv', '--', d.path, target])
      if (mv.exitCode !== 0) throw new Error(mv.stderr)
    } catch (err) {
      return { ok: false, notice: `Déplacement refusé : ${String(err)}`, invalidate: [] }
    }
    await appendJournal(io, env, { action: 'disable-skill', target: d.path, after: target })
    return { ok: true, notice: `Skill déplacé vers ${target} (effet à la prochaine session).`, invalidate: inv }
  }

  return { ok: false, notice: 'Action inconnue.', invalidate: [] }
}

export const runInlineEdit = async (io: ActionIo, env: ActionEnv, item: Item, value: string): Promise<ActionResult> => {
  try {
    return await inlineEditUnguarded(io, env, item, value)
  } catch (err) {
    const path = item.source.kind === 'file' || item.source.kind === 'settings' ? item.source.path : '?'
    return err instanceof SyntaxError ? INVALID_JSON(path) : { ok: false, notice: `Édition en échec : ${String(err)}`, invalidate: [] }
  }
}

const inlineEditUnguarded = async (io: ActionIo, env: ActionEnv, item: Item, value: string): Promise<ActionResult> => {
  const src = item.source
  if (src.kind === 'file' && item.disable?.kind === 'remove-unit' && item.disable.unitId) {
    if (!isWritable(src.path, env)) return { ok: false, notice: `Hors périmètre : ${src.path}`, invalidate: [] }
    const text = await io.readText(src.path)
    if (text === null) return { ok: false, notice: `Fichier introuvable : ${src.path}`, invalidate: [] }
    const out = replaceUnit(text, item.disable.unitId, value)
    if (out === null) return { ok: false, notice: 'Unité introuvable ou multi-ligne : édition par le composer.', invalidate: [] }
    await appendJournal(io, env, { action: 'edit-unit', target: src.path, before: item.text, after: value })
    await io.write(src.path, out)
    return { ok: true, notice: `Modifié dans ${src.path}.`, invalidate: invalidationsFor(item) }
  }
  if (src.kind === 'settings') {
    if (!isWritable(src.path, env)) return { ok: false, notice: `Hors périmètre : ${src.path}`, invalidate: [] }
    const json = await io.readText(src.path)
    if (json === null) return { ok: false, notice: `Fichier introuvable : ${src.path}`, invalidate: [] }
    const before = getKey(json, src.keyPath)
    const parsed: unknown = (() => { try { return JSON.parse(value) as unknown } catch { return value } })()
    const next = setKey(json, src.keyPath, parsed)
    await appendJournal(io, env, { action: 'set-key', target: `${src.path} › ${src.keyPath.join('.')}`, before: JSON.stringify(before), after: JSON.stringify(parsed) })
    await io.write(src.path, next)
    return { ok: true, notice: `${src.keyPath.join('.')} = ${JSON.stringify(parsed)} (effet à la prochaine session).`, invalidate: invalidationsFor(item) }
  }
  return { ok: false, notice: 'Pas d’édition in-pane pour cet élément.', invalidate: [] }
}

/** Pré-remplit le composer avec une demande d'édition ; ne soumet jamais. */
export const fillPromptForEdit = async (io: ActionIo, item: Item): Promise<ActionResult> => {
  const src = item.source
  const where = src.kind === 'file' ? `\`${src.path}\`` : src.kind === 'settings' ? `\`${src.path}\` (clé \`${src.keyPath.join('.')}\`)` : src.kind === 'plugin' && src.root ? `le plugin \`${src.root}\`` : null
  if (where === null) return { ok: false, notice: item.hint ?? 'Pas de source éditable.', invalidate: [] }
  const what = item.disable?.kind === 'remove-unit' ? `le bloc « ${item.title} »` : item.disable?.kind === 'remove-file' ? 'le fichier' : `« ${item.title} »`
  const text = `Modifie dans ${where} ${what} : `
  let box = { text: '' }
  try {
    box = await io.promptRead()
  } catch {
    box = { text: '' }
  }
  const filled = await io.promptFill(box.text.trim() ? { text: `\n${text}`, mode: 'append' } : { text, mode: 'replace' })
  return { ok: filled.isFilled, notice: filled.isFilled ? 'Demande d’édition placée dans le composer : complète-la et envoie.' : 'Le composer n’a pas pris le texte.', invalidate: [] }
}
