// Édition de fichiers JSON de réglages (settings.json) par chemin de clés. Pur : aucune API Node ni DOM.
//
// Principe : on lit le JSON, on modifie l'arbre en mémoire, on réécrit tout avec l'indentation de l'entrée.
// Ce que la relecture garde ou normalise :
// - ordre des clés : conservé (remplacer une clé la laisse à sa place, en ajouter une la met à la fin) ;
//   limite de JS : les clés « entières » ("1", "2"…) passent en tête, par ordre croissant ;
// - fin de fichier : un saut de ligne final si et seulement si l'entrée en avait un
//   (l'espace blanc en fin d'entrée est sinon écarté) ;
// - BOM UTF-8 en tête et fins de ligne CRLF : conservés ;
// - indentation : celle de la première ligne indentée de l'entrée (une tabulation, ou N espaces), 2 espaces si
//   l'entrée n'a aucune ligne indentée (JSON compact) ;
// - formatage compact des tableaux, nombres écrits autrement (`1.0`, `1e3`), échappements `\uXXXX`, clés dupliquées :
//   normalisés par la réécriture.
//
// Chemins (`keyPath`) : un segment `string` désigne une clé d'objet, un segment `number` un index de tableau.
// Les deux ne se mélangent pas : un nombre ne vise jamais une clé d'objet (`{"0": 1}` ne répond pas à `[0]`)
// et une chaîne ne vise jamais un élément de tableau (`["a"]` ne répond pas à `"0"`). Seules les propriétés
// propres sont lues : `['toString']` ou `['constructor']` n'existent pas.
//
// Erreurs :
// - JSON invalide : `SyntaxError` (jamais confondu avec « chemin absent »), pour les trois fonctions ;
// - `keyPath` vide : `RangeError` pour `removeKey` et `setKey` (la racine ne se retire ni ne se remplace) ;
//   `getKey` avec un chemin vide renvoie le document entier.

/** Chemin vers une valeur : noms de clés (objets) et index (tableaux). */
export type KeyPath = (string | number)[]

type Doc = {
  root: unknown
  /** `'\uFEFF'` si l'entrée commençait par un BOM, sinon `''`. */
  bom: string
  eol: '\n' | '\r\n'
  /** Unité d'indentation de l'entrée : `'\t'` ou N espaces (2 par défaut), telle que `JSON.stringify` l'attend. */
  indent: string
  /** L'entrée finissait par un saut de ligne (suivi au plus d'espaces). */
  finalNewline: boolean
}

type Lookup = { found: true; value: unknown } | { found: false }

const DEFAULT_INDENT = '  '

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Pose `key` même s'il s'appelle `__proto__` (l'affectation ordinaire changerait le prototype). */
function define(o: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(o, key, { value, writable: true, enumerable: true, configurable: true })
}

/**
 * Indentation de la première ligne indentée : une tabulation, ou N espaces ; 2 espaces si aucune ligne n'est indentée.
 * Un JSON strict n'a pas de saut de ligne brut dans une chaîne : le début de ligne est toujours de la mise en forme.
 */
function detectIndent(body: string): string {
  const lead = /^([ \t]+)\S/m.exec(body)?.[1]
  if (lead === undefined) return DEFAULT_INDENT
  return lead.startsWith('\t') ? '\t' : ' '.repeat(/^ */.exec(lead)?.[0].length ?? 0)
}

function parseDoc(json: string): Doc {
  const bom = json.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = json.slice(bom.length)
  const finalNewline = body.slice(body.trimEnd().length).includes('\n')
  const eol = /\r?\n/.exec(body)?.[0] === '\r\n' ? '\r\n' : '\n'
  const text = body.trim()
  return { root: JSON.parse(text), bom, eol, finalNewline, indent: detectIndent(text) }
}

function serialize(doc: Doc): string {
  const text = JSON.stringify(doc.root, null, doc.indent)
  // Les sauts de ligne bruts ne viennent que de la mise en forme : ceux des chaînes sont échappés (`\n`).
  const body = doc.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
  return doc.bom + body + (doc.finalNewline ? doc.eol : '')
}

/** Enfant de `container` au segment `seg`, sans jamais traverser un nombre vers un objet ni une chaîne vers un tableau. */
function child(container: unknown, seg: string | number): Lookup {
  if (typeof seg === 'number') {
    if (Array.isArray(container) && Number.isInteger(seg) && seg >= 0 && seg < container.length) {
      return { found: true, value: container[seg] }
    }
    return { found: false }
  }
  if (isRecord(container) && hasOwn(container, seg)) return { found: true, value: container[seg] }
  return { found: false }
}

function lookup(root: unknown, path: KeyPath): Lookup {
  let cur = root
  for (const seg of path) {
    const next = child(cur, seg)
    if (!next.found) return next
    cur = next.value
  }
  return { found: true, value: cur }
}

function describeValue(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'un tableau'
  if (typeof v === 'object') return 'un objet'
  return `une valeur de type ${typeof v}`
}

/**
 * Retire la clé (ou l'élément de tableau) au chemin donné ; les éléments suivants d'un tableau se décalent.
 * Retourne le nouveau texte et la valeur retirée (qui peut être `null`, `0`, `false`…), ou `null` si le chemin n'existe pas.
 * Ne retire pas les parents devenus vides (`{"a":{"b":1}}` sans `a.b` donne `{"a":{}}`) : l'appelant décide.
 * Lève `SyntaxError` si `json` est invalide, `RangeError` si `keyPath` est vide.
 */
export function removeKey(json: string, keyPath: KeyPath): { text: string; removed: unknown } | null {
  const last = keyPath[keyPath.length - 1]
  if (last === undefined) throw new RangeError('removeKey : keyPath vide')
  const doc = parseDoc(json)
  const parent = lookup(doc.root, keyPath.slice(0, -1))
  if (!parent.found) return null
  const target = child(parent.value, last)
  if (!target.found) return null
  if (typeof last === 'number' && Array.isArray(parent.value)) parent.value.splice(last, 1)
  else if (typeof last === 'string' && isRecord(parent.value)) delete parent.value[last]
  return { text: serialize(doc), removed: target.value }
}

/**
 * Pose `value` au chemin donné et retourne le nouveau texte.
 * - clé d'objet existante : remplacée en place ; absente : ajoutée à la fin ;
 * - parents manquants : créés, en objet `{}` si le segment suivant est une chaîne, en tableau `[]` s'il est un nombre
 *   (`['hooks', 'Stop', 0]` crée `Stop: [valeur]`) ;
 * - index de tableau : de `0` à `length` inclus (`length` ajoute à la fin), sinon `RangeError` — pas de trous.
 * Lève `TypeError` quand un segment ne correspond pas au type de ce qu'il traverse : un nombre vers un objet,
 * une chaîne vers un tableau, ou un parent qui est un scalaire / `null` (on n'écrase jamais une valeur existante pour
 * faire de la place). Lève aussi `TypeError` si `value` n'a pas de forme JSON (`undefined`, fonction, symbole),
 * `SyntaxError` si `json` est invalide, `RangeError` si `keyPath` est vide.
 */
export function setKey(json: string, keyPath: KeyPath, value: unknown): string {
  if (keyPath.length === 0) throw new RangeError('setKey : keyPath vide')
  if (JSON.stringify(value) === undefined) throw new TypeError('setKey : la valeur n’a pas de représentation JSON')
  const doc = parseDoc(json)
  let cur: unknown = doc.root
  for (let i = 0; i < keyPath.length; i++) {
    const seg = keyPath[i] as string | number
    const isLast = i === keyPath.length - 1
    const here = JSON.stringify(keyPath.slice(0, i + 1))
    const emptyNext = (): unknown => (typeof keyPath[i + 1] === 'number' ? [] : {})
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) throw new TypeError(`setKey : l’index ${seg} vise ${describeValue(cur)}, pas un tableau (chemin ${here})`)
      if (!Number.isInteger(seg) || seg < 0 || seg > cur.length) {
        throw new RangeError(`setKey : index ${seg} hors d’un tableau de ${cur.length} éléments (chemin ${here})`)
      }
      if (isLast) {
        cur[seg] = value
        break
      }
      if (seg === cur.length) cur.push(emptyNext())
      cur = cur[seg]
    } else {
      if (!isRecord(cur)) throw new TypeError(`setKey : la clé "${seg}" vise ${describeValue(cur)}, pas un objet (chemin ${here})`)
      if (isLast) {
        define(cur, seg, value)
        break
      }
      if (!hasOwn(cur, seg)) define(cur, seg, emptyNext())
      cur = cur[seg]
    }
  }
  return serialize(doc)
}

/** Valeur au chemin donné, ou `undefined` si le chemin n'existe pas (chemin vide : le document entier). Lève `SyntaxError` si `json` est invalide. */
export function getKey(json: string, keyPath: KeyPath): unknown {
  const found = lookup(parseDoc(json).root, keyPath)
  return found.found ? found.value : undefined
}
