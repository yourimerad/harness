// Découpage d'un fichier markdown (CLAUDE.md, rules, notes de mémoire) en « unités »
// que le mod peut montrer, retirer ou éditer à la source. Contrat : DESIGN.md §« Contrats des modules purs ».
//
// Module pur : aucune API Node ni DOM, uniquement des built-ins JS standard (il tourne dans le bac à sable du plugin).
//
// Invariant du découpage : toute ligne non vide du corps (hors frontmatter) est soit un titre ATX,
// soit contenue dans exactement une unité. Rien n'est donc invisible, et retirer toutes les unités
// ne laisse que le frontmatter, des titres et des blancs.

export type UnitKind = 'bullet' | 'paragraph' | 'import' | 'code' | 'table' | 'quote' | 'other'

export type Unit = {
  /** `h<hash8(texte normalisé)>-<n>` : n = rang (0-based) parmi les unités de même hash, dans l'ordre du fichier. */
  id: string
  kind: UnitKind
  /** Titres au-dessus, du plus haut au plus proche, sans les `#`. */
  headingPath: string[]
  /** Première ligne sans marqueur de liste, ≤ 80 caractères. */
  title: string
  /** Tranche exacte du source (sauts de ligne normalisés en `\n`), sans saut de ligne final. */
  text: string
  /** Index de ligne (0-based) de la première ligne. */
  start: number
  /** Index de ligne après la dernière (exclusif). */
  end: number
  /** Une seule ligne, sans enfant : éditable dans le pane. */
  isSingleLine: boolean
}

export type Heading = { level: number; title: string; line: number }

export type ParsedDoc = {
  /** Bloc `---…---` en tête de fichier, fences comprises, sans saut de ligne final ; jamais une unité. */
  frontmatter: string | null
  headings: Heading[]
  units: Unit[]
}

// ---------------------------------------------------------------------------
// Motifs de lignes
// ---------------------------------------------------------------------------

const BLANK = /^[ \t]*$/
const FRONTMATTER_FENCE = /^---[ \t]*$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
/** Marqueur de puce au plus à 3 espaces de la marge ; groupe 2 = numéro d'une liste ordonnée. */
const LIST_ITEM = /^( {0,3})(?:[-*+]|(\d{1,9})[.)])(?:[ \t]|$)/
const LIST_PREFIX = /^( {0,3}(?:[-*+]|\d{1,9}[.)]))(?:[ \t]+|$)/
const LIST_MARKER_TEXT = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
/** Fermeture tolérante, pour un fence rencontré à l'intérieur d'une puce (indentation libre). */
const FENCE_CLOSE_LOOSE = /^\s*(`{3,}|~{3,})[ \t]*$/
const QUOTE = /^ {0,3}>/
const TABLE_ROW = /^ {0,3}\|/
const IMPORT = /^ {0,3}@\S+[ \t]*$/
const COMMENT_OPEN = /^ {0,3}<!--/

const TITLE_MAX = 80

// ---------------------------------------------------------------------------
// Briques de lecture
// ---------------------------------------------------------------------------

type Fence = { ch: string; len: number }

function matchFence(line: string): Fence | null {
  const m = FENCE_OPEN.exec(line)
  if (!m) return null
  const marker = m[1] ?? ''
  const info = m[2] ?? ''
  // Un fence ``` dont la ligne d'info contient un backtick est du code en ligne, pas un fence.
  if (marker.startsWith('`') && info.includes('`')) return null
  return { ch: marker.charAt(0), len: marker.length }
}

function closesFence(line: string, fence: Fence, loose: boolean): boolean {
  const m = (loose ? FENCE_CLOSE_LOOSE : FENCE_CLOSE).exec(line)
  if (!m) return false
  const marker = m[1] ?? ''
  return marker.charAt(0) === fence.ch && marker.length >= fence.len
}

/** Index de la ligne fermant le fence ouvert avant `from`, ou -1. */
function findFenceClose(lines: string[], from: number, fence: Fence, loose: boolean): number {
  for (let j = from; j < lines.length; j++) {
    if (closesFence(lines[j] ?? '', fence, loose)) return j
  }
  return -1
}

function parseHeading(line: string): { level: number; title: string } | null {
  const m = HEADING.exec(line)
  if (!m) return null
  let title = (m[2] ?? '').trim()
  // Séquence de fermeture optionnelle (`## Titre ##`) : seulement si précédée d'un blanc.
  title = title.replace(/(?:^|[ \t]+)#+$/, '').trim()
  return { level: (m[1] ?? '').length, title }
}

/**
 * Commentaire HTML sur ses propres lignes : retourne l'index de la dernière ligne du commentaire,
 * ou null si la ligne n'ouvre pas un commentaire complet qui se ferme en fin de ligne.
 */
function commentEnd(lines: string[], i: number): number | null {
  const open = COMMENT_OPEN.exec(lines[i] ?? '')
  if (!open) return null
  let from = open[0].length
  for (let j = i; j < lines.length; j++) {
    const l = lines[j] ?? ''
    const k = l.indexOf('-->', from)
    if (k !== -1) return BLANK.test(l.slice(k + 3)) ? j : null
    from = 0
  }
  return null
}

/** Largeur d'indentation : une tabulation vaut 4. */
function indentWidth(line: string): number {
  let w = 0
  for (const ch of line) {
    if (ch === ' ') w += 1
    else if (ch === '\t') w += 4
    else break
  }
  return w
}

/**
 * La ligne `j` ouvre-t-elle un bloc à elle ?
 * `interruptsParagraph` : on est dans un paragraphe (règles CommonMark : seule une puce non vide,
 * ou « 1. », interrompt un paragraphe). Sinon on est dans une puce, où tout marqueur de liste
 * est un frère.
 */
function startsBlock(lines: string[], j: number, interruptsParagraph: boolean): boolean {
  const l = lines[j] ?? ''
  if (HEADING.test(l)) return true
  if (matchFence(l)) return true
  if (THEMATIC_BREAK.test(l)) return true
  if (QUOTE.test(l) || TABLE_ROW.test(l) || IMPORT.test(l)) return true
  if (commentEnd(lines, j) !== null) return true
  const li = LIST_ITEM.exec(l)
  if (li) {
    if (!interruptsParagraph) return true
    if (BLANK.test(l.slice(li[0].length))) return false
    if (li[2] !== undefined && Number(li[2]) !== 1) return false
    return true
  }
  return false
}

/**
 * Fin (exclusive) d'une puce de premier niveau commençant à `start`, marqueur à `base` espaces.
 * Appartiennent à la puce : les lignes indentées d'au moins base+2 (ou une tabulation), y compris
 * après des lignes vides ; les sous-puces ; un fence ouvert dans la puce jusqu'à sa fermeture ;
 * et une ligne de texte collée sans indentation (continuation « paresseuse » de CommonMark).
 */
function scanBullet(lines: string[], start: number, base: number): number {
  const n = lines.length
  let end = start + 1
  let j = start + 1
  let afterFence = false
  while (j < n) {
    let line = lines[j] ?? ''
    if (BLANK.test(line)) {
      let k = j + 1
      while (k < n && BLANK.test(lines[k] ?? '')) k++
      if (k >= n || indentWidth(lines[k] ?? '') < base + 2) break
      j = k
      line = lines[k] ?? ''
    }
    if (indentWidth(line) >= base + 2) {
      const fence = matchFence(line.trimStart())
      if (fence) {
        const close = findFenceClose(lines, j + 1, fence, true)
        if (close !== -1) {
          end = close + 1
          j = close + 1
          afterFence = true
          continue
        }
      }
      end = j + 1
      j += 1
      afterFence = false
      continue
    }
    if (startsBlock(lines, j, false)) break
    // Texte non indenté collé à la puce : continuation paresseuse, sauf juste après un bloc de code fermé.
    if (afterFence) break
    end = j + 1
    j += 1
  }
  return end
}

function truncate(s: string): string {
  if (s.length <= TITLE_MAX) return s
  let cut = s.slice(0, TITLE_MAX - 1)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1) // ne pas couper une paire de substitution
  return cut.trimEnd() + '…'
}

function makeTitle(firstLine: string, kind: UnitKind): string {
  let t = firstLine.trim()
  if (kind === 'bullet') t = t.replace(/^(?:[-*+]|\d{1,9}[.)])[ \t]*/, '')
  return truncate(t)
}

/** FNV-1a 32 bits sur les unités de code UTF-16, en 8 chiffres hexadécimaux. */
function hash8(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Texte normalisé pour l'identifiant : sans blancs de fin de ligne ni de bout de bloc. */
function normalizeForId(text: string): string {
  return text
    .split('\n')
    .map(l => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim()
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

type Analysis = {
  lines: string[]
  endsWithNewline: boolean
  /** Index de la première ligne après le frontmatter (0 s'il n'y en a pas). */
  bodyStart: number
  frontmatter: string | null
  headings: Heading[]
  units: Unit[]
}

function analyze(source: string): Analysis {
  const normalized = source.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const n = lines.length

  // Frontmatter : `---` en toute première ligne et une fermeture `---` plus bas.
  // Un `---` plus loin dans le fichier est une ligne de séparation, jamais un frontmatter.
  let bodyStart = 0
  let frontmatter: string | null = null
  if (FRONTMATTER_FENCE.test(lines[0] ?? '')) {
    for (let j = 1; j < n; j++) {
      if (FRONTMATTER_FENCE.test(lines[j] ?? '')) {
        frontmatter = lines.slice(0, j + 1).join('\n')
        bodyStart = j + 1
        break
      }
    }
  }

  const units: Unit[] = []
  const headings: Heading[] = []
  const stack: Heading[] = []
  const ranks = new Map<string, number>()

  const push = (kind: UnitKind, start: number, end: number): void => {
    const text = lines.slice(start, end).join('\n')
    const hash = hash8(normalizeForId(text))
    const rank = ranks.get(hash) ?? 0
    ranks.set(hash, rank + 1)
    units.push({
      id: `h${hash}-${rank}`,
      kind,
      headingPath: stack.map(h => h.title),
      title: makeTitle(lines[start] ?? '', kind),
      text,
      start,
      end,
      isSingleLine: end - start === 1,
    })
  }

  let i = bodyStart
  while (i < n) {
    const line = lines[i] ?? ''
    if (BLANK.test(line)) {
      i += 1
      continue
    }

    // Titre ATX : conteneur, jamais une unité.
    const h = parseHeading(line)
    if (h) {
      const heading: Heading = { level: h.level, title: h.title, line: i }
      headings.push(heading)
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= h.level) stack.pop()
      stack.push(heading)
      i += 1
      continue
    }

    // Bloc de code clôturé : opaque, rien n'y est analysé. Non fermé : jusqu'à la fin du fichier.
    const fence = matchFence(line)
    if (fence) {
      const close = findFenceClose(lines, i + 1, fence, false)
      let end = close === -1 ? n : close + 1
      while (end > i + 1 && BLANK.test(lines[end - 1] ?? '')) end -= 1
      push('code', i, end)
      i = end
      continue
    }

    // Ligne de séparation (`---`, `***`, `___`) : visible comme unité `other`.
    if (THEMATIC_BREAK.test(line)) {
      push('other', i, i + 1)
      i += 1
      continue
    }

    // Commentaire HTML sur ses propres lignes.
    const ce = commentEnd(lines, i)
    if (ce !== null) {
      push('other', i, ce + 1)
      i = ce + 1
      continue
    }

    if (QUOTE.test(line)) {
      let j = i + 1
      while (j < n && QUOTE.test(lines[j] ?? '')) j += 1
      push('quote', i, j)
      i = j
      continue
    }

    if (TABLE_ROW.test(line)) {
      let j = i + 1
      while (j < n && TABLE_ROW.test(lines[j] ?? '')) j += 1
      push('table', i, j)
      i = j
      continue
    }

    if (IMPORT.test(line)) {
      push('import', i, i + 1)
      i += 1
      continue
    }

    const li = LIST_ITEM.exec(line)
    if (li) {
      const end = scanBullet(lines, i, (li[1] ?? '').length)
      push('bullet', i, end)
      i = end
      continue
    }

    // Paragraphe : lignes non vides consécutives, jusqu'à une ligne vide ou un autre bloc.
    let j = i + 1
    while (j < n && !BLANK.test(lines[j] ?? '') && !startsBlock(lines, j, true)) j += 1
    push('paragraph', i, j)
    i = j
  }

  return { lines, endsWithNewline: normalized.endsWith('\n'), bodyStart, frontmatter, headings, units }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export function parseUnits(text: string): ParsedDoc {
  const a = analyze(text)
  return { frontmatter: a.frontmatter, headings: a.headings, units: a.units }
}

/** Index de ligne (exclusif) où s'arrête le sous-arbre du titre `hi` : le prochain titre de niveau ≤ au sien. */
function subtreeEnd(headings: Heading[], hi: number, lineCount: number): number {
  const h = headings[hi]
  if (!h) return lineCount
  for (let k = hi + 1; k < headings.length; k++) {
    const other = headings[k]
    if (other && other.level <= h.level) return other.line
  }
  return lineCount
}

/**
 * Retire l'unité ; retire aussi tout titre dont le sous-arbre contenait l'unité et n'a plus d'unité ;
 * normalise les blancs autour des retraits (≤ 1 ligne vide consécutive, pas de blancs de fin,
 * saut de ligne final conservé s'il y en avait un). Le reste du fichier n'est pas touché, et les
 * lignes vides à l'intérieur d'une unité (bloc de code, puce aérée) ne sont jamais modifiées.
 * Le résultat est relu : si le retrait faisait fusionner deux unités voisines (deux paragraphes collés
 * de part et d'autre d'un bloc de code, un `---` devenu première ligne…), une ligne vide est ajoutée à la jonction.
 * `text: null` quand il ne reste aucune unité (que du frontmatter, des titres, des blancs) : le fichier est à supprimer.
 * Les sauts de ligne `\r\n` sont normalisés en `\n`.
 */
export function removeUnit(text: string, unitId: string): { text: string | null; removed: Unit } | null {
  const a = analyze(text)
  const removed = a.units.find(u => u.id === unitId)
  if (!removed) return null
  const remaining = a.units.filter(u => u !== removed)
  if (remaining.length === 0) return { text: null, removed }

  const n = a.lines.length
  const dropped = new Set<number>()
  for (let l = removed.start; l < removed.end; l++) dropped.add(l)

  // Titres devenus vides à cause de ce retrait (en cascade : le test porte sur les unités, pas sur les titres).
  a.headings.forEach((h, hi) => {
    const stop = subtreeEnd(a.headings, hi, n)
    if (removed.start <= h.line || removed.start >= stop) return
    if (!remaining.some(u => u.start > h.line && u.start < stop)) dropped.add(h.line)
  })

  // Lignes qui ne sont ni du frontmatter, ni un titre, ni dans une unité : les blancs entre blocs.
  const owned = new Array<boolean>(n).fill(false)
  for (let l = 0; l < a.bodyStart; l++) owned[l] = true
  for (const h of a.headings) owned[h.line] = true
  for (const u of a.units) for (let l = u.start; l < u.end; l++) owned[l] = true

  // Assemble le texte sans les lignes retirées. Les blancs ne sont normalisés qu'aux jonctions touchées
  // par un retrait ; `separate` y impose une ligne vide, pour que deux blocs voisins ne fusionnent pas.
  const assemble = (separate: boolean): string => {
    const out: string[] = []
    let run = 0 // lignes vides conservées en attente avant la prochaine ligne de contenu
    let touched = false // un retrait a eu lieu dans cet intervalle
    const flush = (atEnd: boolean): void => {
      let count = touched ? Math.min(run, 1) : run
      if (atEnd) count = 0
      else if (out.length === 0 && touched) count = 0
      else if (separate && touched) count = Math.max(count, 1)
      for (let c = 0; c < count; c++) out.push('')
      run = 0
      touched = false
    }
    for (let l = 0; l < n; l++) {
      if (dropped.has(l)) {
        touched = true
        continue
      }
      if (!owned[l]) {
        run += 1
        continue
      }
      flush(false)
      out.push(a.lines[l] ?? '')
    }
    flush(true)
    return out.join('\n') + (a.endsWithNewline ? '\n' : '')
  }

  // Sans ligne vide, retirer un bloc collé entre deux paragraphes (ou deux citations, deux tableaux,
  // une puce et du texte) les fusionnerait en une seule unité : on relit pour le vérifier.
  const expected = remaining.map(u => u.text)
  const sameUnits = (candidate: string): boolean => {
    const got = analyze(candidate).units
    return got.length === expected.length && got.every((u, k) => u.text === expected[k])
  }
  // Candidats par ordre de préférence (diff minimal d'abord). Dernier recours : un `---` devenu première
  // ligne serait relu comme un frontmatter ; une ligne vide en tête l'en empêche.
  const tight = assemble(false)
  const apart = assemble(true)
  const candidates = [tight, apart]
  if (a.frontmatter === null) candidates.push('\n' + tight, '\n' + apart)
  // Si rien ne préserve les unités (cas dégénéré), on garde le diff minimal : aucun texte n'est perdu.
  const result = candidates.find(sameUnits) ?? tight

  return { text: result, removed }
}

/**
 * Remplace le texte d'une unité mono-ligne. Pour une puce, le marqueur d'origine (et son indentation)
 * est conservé si `newText` n'en porte pas ; s'il en porte un (`- `, `* `, `+ `, `1. `), il n'est pas doublé.
 * Retourne null si l'unité est inconnue, si elle n'est pas mono-ligne, ou si `newText` est vide
 * ou contient un saut de ligne (pour retirer, voir `removeUnit`). Les `\r\n` sont normalisés en `\n`.
 */
export function replaceUnit(text: string, unitId: string, newText: string): string | null {
  const a = analyze(text)
  const unit = a.units.find(u => u.id === unitId)
  if (!unit || !unit.isSingleLine) return null

  const body = newText.replace(/\r\n?/g, '\n').trim()
  if (body === '' || body.includes('\n')) return null

  const old = a.lines[unit.start] ?? ''
  let replacement = body
  if (unit.kind === 'bullet') {
    const indent = /^ */.exec(old)?.[0] ?? ''
    if (LIST_MARKER_TEXT.test(body)) {
      replacement = indent + body
    } else {
      const prefix = LIST_PREFIX.exec(old)?.[0] ?? '- '
      replacement = (/[ \t]$/.test(prefix) ? prefix : prefix + ' ') + body
    }
  }

  const lines = a.lines.slice()
  lines[unit.start] = replacement
  return lines.join('\n')
}
