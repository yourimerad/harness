// Bout en bout dans le kit : un ~/.claude fictif répond aux lectures, session.start construit l'inventaire,
// le pane le dessine sur chaque surface, et une désactivation écrit à la source puis journalise.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { CWD, DIRS, FILES, HOME, SNAP, io as fixtures } from './fixtures'

const PANE = {
  plugin: 'harness',
  component: 'Pane' as const,
  requestId: 'harness',
  props: { title: 'Harnais', isFocused: false, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: 160, rows: 50, isFullscreen: true },
}

/** Branche les nouns que le mod appelle sur un disque en mémoire et des réponses fixes. */
const wire = (on: On, files: Record<string, string>, dirs: Record<string, string[]>) => {
  mock.env(on, { HOME })
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  const runs: string[][] = []
  const invalidated: string[] = []
  const status: Array<string | undefined> = []
  // Un appel de noun est répondu par `{ value }` ; un événement (session.start, prompt.compose) par son résultat.
  on('fs.read', ($, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', ($, e) => ({ value: (dirs[e.path] ?? []).map(name => ({ name, kind: `${e.path}/${name}` in files ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 1, isLink: false })) }))
  on('fs.exists', ($, e) => ({ value: e.path in files || e.path in dirs }))
  on('fs.stat', ($, e) => {
    if (!(e.path in files) && !(e.path in dirs)) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: e.path in files ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 1, isLink: false } }
  })
  on('fs.ancestors', () => ({ value: [] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.root', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.list', async () => ({ value: [...(await fixtures().commands())] }))
  on('tool.list', async () => ({ value: [...(await fixtures().tools())] }))
  on('prompt.compose', () => ({ sections: SNAP.sections }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
  on('command.register', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', ($, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.invalidate', ($, e) => {
    invalidated.push(e.event)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'rm') delete files[e.argv[2] ?? '']
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { runs, invalidated, status, clock }
}

const EXPORT = `${HOME}/.claude/harness/inventory.json`

const CLAUDE_KEY = `sel:claudeMd/${HOME}/.claude/CLAUDE.md`

test('session.start construit l’inventaire et la status line ; le pane se dessine et navigue sur chaque surface', async ($, on) => {
  const files = { ...FILES }
  const { status } = wire(on, files, { ...DIRS })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  expect(status.at(-1)).toMatch(/^harness: \d+ instr · ≈ /)

  for (const surface of ['terminal', 'desktop'] as const) {
    const drawn = await $.ui.mount({ ...PANE, surface })
    expect(await drawn.find({ type: 'Text', text: /Harnais/ })).toBeDefined()
    expect(await drawn.find({ type: 'Text', text: /instructions non-vanilla/ })).toBeDefined()
    // CLAUDE.md est déplié d'office ; le moteur est replié
    expect(await drawn.find({ key: CLAUDE_KEY })).toBeDefined()
    expect(await drawn.find({ key: 'sel:engine/section/intro' })).toBeUndefined()
    expect(await drawn.find({ type: 'Button', text: /Locale française/ })).toBeUndefined()
    // un clic sur le fichier le déplie, le sélectionne, et offre la suppression du fichier
    await drawn.press({ key: CLAUDE_KEY })
    expect(await drawn.find({ type: 'Button', text: /Locale française/ })).toBeDefined()
    expect((await drawn.find({ key: CLAUDE_KEY.replace('sel:', 'disable:') }))?.text).toBe('Supprimer le fichier')
    // la suppression d'un fichier entier demande un second clic : rien n'est écrit au premier
    await drawn.press({ key: CLAUDE_KEY.replace('sel:', 'disable:') })
    expect((await drawn.find({ key: CLAUDE_KEY.replace('sel:', 'disable:') }))?.text).toContain('Confirmer')
    expect(files[`${HOME}/.claude/CLAUDE.md`]).toContain('Locale française')
    // le moteur se déplie à la demande
    await drawn.press({ key: 'sel:engine' })
    expect(await drawn.find({ key: 'sel:engine/section/intro' })).toBeDefined()
    await drawn.press({ key: 'sel:engine' })
    // l'état est celui de la session : on replie le fichier pour la surface suivante
    await drawn.press({ key: CLAUDE_KEY })
    expect(await drawn.find({ type: 'Button', text: /Locale française/ })).toBeUndefined()
    await drawn.unmount()
  }
})

test('désactiver une puce écrit le fichier sans elle, journalise, invalide prompt.context et marque l’attente', async ($, on) => {
  const files = { ...FILES }
  const { invalidated } = wire(on, files, { ...DIRS })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const drawn = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await drawn.press({ key: CLAUDE_KEY })
  const unit = await drawn.find({ type: 'Button', text: /Locale française/ })
  expect(unit?.key).toBeDefined()
  await drawn.press({ key: unit!.key! })
  // unité mono-ligne : Modifier ouvre un champ pré-rempli sans le marqueur de liste
  await drawn.press({ key: unit!.key!.replace('sel:', 'edit:') })
  expect((await drawn.find({ key: unit!.key!.replace('sel:', 'input:') }))?.props.value).toBe('Locale française.')
  await drawn.press({ key: unit!.key!.replace('sel:', 'cancel:') })
  // Désactiver : un clic suffit pour une unité
  await drawn.press({ key: unit!.key!.replace('sel:', 'disable:') })
  expect(files[`${HOME}/.claude/CLAUDE.md`]).toBe('# Contexte\n\n## Machine\n- Secrets via `$VAR`.\n\n## Code\n- Stack TypeScript.\n')
  expect(files[`${HOME}/.claude/harness/journal.md`]).toContain('Locale française.')
  expect(invalidated).toContain('prompt.context')
  expect(await drawn.find({ type: 'Text', text: /en attente du prochain tour|Retiré de/ })).toBeDefined()
  await drawn.unmount()
})

test('éditer une puce in-pane remplace la ligne à la source', async ($, on) => {
  const files = { ...FILES }
  wire(on, files, { ...DIRS })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const drawn = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await drawn.press({ key: CLAUDE_KEY })
  const unit = await drawn.find({ type: 'Button', text: /Stack TypeScript/ })
  await drawn.press({ key: unit!.key! })
  await drawn.press({ key: unit!.key!.replace('sel:', 'edit:') })
  await drawn.input({ key: unit!.key!.replace('sel:', 'input:'), text: 'Stack TypeScript et pnpm.' })
  expect(files[`${HOME}/.claude/CLAUDE.md`]).toContain('- Stack TypeScript et pnpm.\n')
  expect(files[`${HOME}/.claude/CLAUDE.md`]).not.toContain('- Stack TypeScript.\n')
  await drawn.unmount()
})

test('sur mobile, le pane renvoie un message au lieu de l’arbre', async ($, on) => {
  wire(on, { ...FILES }, { ...DIRS })
  const drawn = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await drawn.find({ type: 'Text', text: /bureau/ })).toBeDefined()
  await drawn.unmount()
})

test('l’export nomme la session ; une capture (prompt.context) reconstruit au tick suivant, sans attendre la fin du tour', async ($, on) => {
  const files = { ...FILES }
  const { clock } = wire(on, files, { ...DIRS })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const first = JSON.parse(files[EXPORT]!) as { sessionId: string; cwd: string; blocks: unknown[]; instructionFiles: unknown[] }
  expect(first.sessionId).toBe('sess-1')
  expect(first.cwd).toBe(CWD)
  expect(first.blocks).toEqual([])
  // le premier message arrive : blocs et fichiers d'instructions observés
  await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'framed' }, { name: 'userEmail', text: 'y@y' }], instructionFiles: [{ path: `${HOME}/.claude/CLAUDE.md`, kind: 'user', content: '# Contexte\n\n## Machine\n- Locale française.\n- Secrets via `$VAR`.\n\n## Code\n- Stack TypeScript.\n' }] })
  await clock.advance(5_000)
  const second = JSON.parse(files[EXPORT]!) as { observedClaudeMd: boolean; blocks: { name: string }[]; instructionFiles: { path: string }[] }
  expect(second.blocks.map(b => b.name)).toEqual(['claudeMd', 'userEmail'])
  expect(second.instructionFiles.map(f => f.path)).toEqual([`${HOME}/.claude/CLAUDE.md`])
  expect(second.observedClaudeMd).toBe(true)
})
