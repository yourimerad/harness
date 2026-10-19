// Mise en forme d'une entrée du journal (`~/.claude/harness/journal.md`, append-only). Pur : aucune API Node.

export type JournalAction =
  | 'remove-unit'
  | 'remove-file'
  | 'edit-unit'
  | 'remove-key'
  | 'set-key'
  | 'disable-plugin'
  | 'disable-skill'
  | 'remove-hook'

export type JournalEntry = {
  /** Horodatage, tel que l'appelant le fournit (ISO conseillé). */
  at: string
  action: JournalAction
  /** Fichier, clé ou plugin visé. */
  target: string
  /** Contenu avant l'action. `''` est un contenu vide (bloc affiché) ; `undefined` = pas de bloc. */
  before?: string
  /** Contenu après l'action. Mêmes règles que `before`. */
  after?: string
  note?: string
}

/** Plus longue suite de backticks consécutifs dans `text` (0 s'il n'y en a pas). */
function longestBacktickRun(text: string): number {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return longest
}

/** Une seule ligne, sans retour chariot : l'en-tête d'une entrée ne doit jamais s'étaler. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

/**
 * Bloc de code dont la clôture dépasse toute suite de backticks du contenu (3 au minimum) :
 * un contenu qui porte lui-même des ``` ne peut donc ni fermer ni casser le bloc.
 * Le saut de ligne final du contenu (une seule fois) est une terminaison de ligne, pas du contenu.
 */
function fenced(content: string): string {
  const body = content.replace(/\r?\n$/, '')
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1))
  return body === '' ? `${fence}\n${fence}` : `${fence}\n${body}\n${fence}`
}

/** Note en citation : une clôture ou un titre `## ` dans la note ne peut pas déborder sur les entrées suivantes. */
function quoted(note: string): string {
  return note
    .replace(/(\r?\n)+$/, '')
    .split(/\r?\n/)
    .map(line => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

/**
 * Entrée de journal en markdown :
 *
 *     ## <at> · <action> · <target>
 *
 *     > note                      (si présente et non vide)
 *
 *     **Avant**                   (si `before` est défini)
 *
 *     ```                         (clôture plus longue que tout backtick du contenu)
 *     contenu
 *     ```
 *
 *     **Après**                   (si `after` est défini)
 *     …
 *
 * Se termine par exactement un saut de ligne. L'appelant sépare les entrées par une ligne vide.
 */
export function formatEntry(e: JournalEntry): string {
  const blocks = [`## ${oneLine(e.at)} · ${e.action} · ${oneLine(e.target)}`]
  if (e.note !== undefined && e.note.trim() !== '') blocks.push(quoted(e.note))
  if (e.before !== undefined) blocks.push('**Avant**', fenced(e.before))
  if (e.after !== undefined) blocks.push('**Après**', fenced(e.after))
  return `${blocks.join('\n\n')}\n`
}
