import { test, expect, describe } from 'claude-code/testing'
import { getKey, removeKey, setKey } from '../hooks/lib/settings'

/** Résultat de removeKey attendu non nul. */
function must<T>(value: T | null): T {
  if (value === null) throw new Error('résultat inattendu : null')
  return value
}

/** JSON mis en forme comme le module l'écrit : 2 espaces, saut de ligne final optionnel. */
const fmt = (value: unknown, finalNewline = true): string => JSON.stringify(value, null, 2) + (finalNewline ? '\n' : '')

const SETTINGS = {
  model: 'opus',
  hooks: { Stop: [{ command: 'a' }, { command: 'b' }], PreToolUse: [] },
  env: { X: '1' },
  enabledPlugins: { 'hcc@local': true },
}

describe('getKey', () => {
  test('lit une clé de premier niveau et une clé imbriquée', () => {
    const json = fmt(SETTINGS)
    expect(getKey(json, ['model'])).toBe('opus')
    expect(getKey(json, ['env', 'X'])).toBe('1')
    expect(getKey(json, ['enabledPlugins', 'hcc@local'])).toBe(true)
  })

  test('lit un index de tableau : [hooks, Stop, 0]', () => {
    const json = fmt(SETTINGS)
    expect(getKey(json, ['hooks', 'Stop', 0])).toEqual({ command: 'a' })
    expect(getKey(json, ['hooks', 'Stop', 1, 'command'])).toBe('b')
    expect(getKey(json, ['hooks', 'Stop'])).toEqual([{ command: 'a' }, { command: 'b' }])
  })

  test('chemin vide : le document entier', () => {
    expect(getKey(fmt(SETTINGS), [])).toEqual(SETTINGS)
  })

  test('chemin absent : undefined', () => {
    const json = fmt(SETTINGS)
    expect(getKey(json, ['nope'])).toBeUndefined()
    expect(getKey(json, ['hooks', 'Stop', 2])).toBeUndefined()
    expect(getKey(json, ['hooks', 'Stop', -1])).toBeUndefined()
    expect(getKey(json, ['hooks', 'Stop', 0.5])).toBeUndefined()
    expect(getKey(json, ['model', 'x'])).toBeUndefined() // traverser une chaîne
    expect(getKey(fmt({ a: null }), ['a', 'b'])).toBeUndefined() // traverser null
  })

  test('les valeurs « fausses » sont rendues telles quelles, pas confondues avec une absence', () => {
    const json = fmt({ zero: 0, no: false, empty: '', nothing: null })
    expect(getKey(json, ['zero'])).toBe(0)
    expect(getKey(json, ['no'])).toBe(false)
    expect(getKey(json, ['empty'])).toBe('')
    expect(getKey(json, ['nothing'])).toBeNull()
  })

  test('un nombre ne vise jamais une clé d’objet, une chaîne jamais un élément de tableau', () => {
    expect(getKey('{"0": "x"}', [0])).toBeUndefined()
    expect(getKey('{"0": "x"}', ['0'])).toBe('x')
    expect(getKey('["x"]', ['0'])).toBeUndefined()
    expect(getKey('["x"]', [0])).toBe('x')
  })

  test('ne remonte pas la chaîne de prototypes', () => {
    const json = fmt({ a: 1 })
    expect(getKey(json, ['toString'])).toBeUndefined()
    expect(getKey(json, ['constructor'])).toBeUndefined()
    expect(getKey(json, ['__proto__'])).toBeUndefined()
    expect(getKey(json, ['hasOwnProperty'])).toBeUndefined()
  })

  test('accepte un BOM UTF-8 et des blancs en fin de fichier', () => {
    expect(getKey('﻿{"a": 1}', ['a'])).toBe(1)
    expect(getKey('{"a": 1}  \n\n\t ', ['a'])).toBe(1)
    expect(getKey('﻿\n  {"a": 1}\r\n', ['a'])).toBe(1)
  })

  test('JSON invalide : SyntaxError, pas undefined', () => {
    expect(() => getKey('{"a": ', ['a'])).toThrow(SyntaxError)
    expect(() => getKey('', ['a'])).toThrow(SyntaxError)
    expect(() => getKey('  \n', ['a'])).toThrow(SyntaxError)
  })
})

describe('removeKey', () => {
  test('retire une clé de premier niveau, les autres gardent leur ordre', () => {
    const out = must(removeKey(fmt(SETTINGS), ['hooks']))
    expect(out.text).toBe(fmt({ model: 'opus', env: { X: '1' }, enabledPlugins: { 'hcc@local': true } }))
    expect(Object.keys(JSON.parse(out.text))).toEqual(['model', 'env', 'enabledPlugins'])
  })

  test('sortie exacte : indentation de 2 espaces', () => {
    const out = must(removeKey('{"a":{"b":1,"c":[1,2]},"d":2}', ['d']))
    expect(out.text).toBe('{\n  "a": {\n    "b": 1,\n    "c": [\n      1,\n      2\n    ]\n  }\n}')
  })

  test('saut de ligne final conservé si et seulement si l’entrée en avait un', () => {
    const withNewline = must(removeKey(fmt(SETTINGS, true), ['model']))
    expect(withNewline.text.endsWith('\n')).toBe(true)
    expect(withNewline.text.endsWith('\n\n')).toBe(false)
    const without = must(removeKey(fmt(SETTINGS, false), ['model']))
    expect(without.text.endsWith('\n')).toBe(false)
    expect(without.text.endsWith('}')).toBe(true)
  })

  test('retire une clé imbriquée sans retirer le parent devenu vide', () => {
    const out = must(removeKey(fmt({ env: { X: '1' }, model: 'opus' }), ['env', 'X']))
    expect(out.text).toBe(fmt({ env: {}, model: 'opus' }))
    expect(out.removed).toBe('1')
  })

  test('retire un élément de tableau par index : [hooks, Stop, 0]', () => {
    const out = must(removeKey(fmt(SETTINGS), ['hooks', 'Stop', 0]))
    expect(out.removed).toEqual({ command: 'a' })
    expect(JSON.parse(out.text).hooks.Stop).toEqual([{ command: 'b' }]) // les suivants se décalent
    expect(JSON.parse(out.text).hooks.PreToolUse).toEqual([])
  })

  test('retire le dernier élément d’un tableau : le tableau reste, vide', () => {
    const out = must(removeKey(fmt({ list: ['x'] }), ['list', 0]))
    expect(out.text).toBe(fmt({ list: [] }))
    expect(out.removed).toBe('x')
  })

  test('rend la valeur retirée, objets entiers compris', () => {
    const out = must(removeKey(fmt(SETTINGS), ['hooks']))
    expect(out.removed).toEqual(SETTINGS.hooks)
  })

  test('une valeur retirée « fausse » n’est pas confondue avec un chemin absent', () => {
    const asNull = must(removeKey('{"a": null, "b": 1}', ['a']))
    expect(asNull.removed).toBeNull()
    expect(asNull.text).toBe(fmt({ b: 1 }, false))
    expect(must(removeKey('{"a": 0}', ['a'])).removed).toBe(0)
    expect(must(removeKey('{"a": false}', ['a'])).removed).toBe(false)
    expect(must(removeKey('{"a": ""}', ['a'])).removed).toBe('')
  })

  test('chemin absent : null', () => {
    const json = fmt(SETTINGS)
    expect(removeKey(json, ['nope'])).toBeNull()
    expect(removeKey(json, ['env', 'nope'])).toBeNull()
    expect(removeKey(json, ['nope', 'deeper'])).toBeNull()
    expect(removeKey(json, ['hooks', 'Stop', 2])).toBeNull()
    expect(removeKey(json, ['hooks', 'Stop', -1])).toBeNull()
    expect(removeKey(json, ['hooks', 'Stop', 0.5])).toBeNull()
    expect(removeKey(json, ['model', 'x'])).toBeNull() // traverser une chaîne
    expect(removeKey(fmt({ a: null }), ['a', 'b'])).toBeNull() // traverser null
    expect(removeKey(json, ['toString'])).toBeNull() // pas de propriété héritée
    expect(removeKey(json, ['hooks', 'Stop', 'length'])).toBeNull()
  })

  test('segment numérique vers un objet, segment texte vers un tableau : chemin absent, rien n’est retiré', () => {
    // Choix documenté dans settings.ts : un nombre ne vise que les tableaux, une chaîne que les objets.
    expect(removeKey('{"0": "x"}', [0])).toBeNull()
    expect(must(removeKey('{"0": "x", "1": "y"}', ['0'])).text).toBe(fmt({ '1': 'y' }, false))
    expect(removeKey('["x"]', ['0'])).toBeNull()
  })

  test('réindente en 2 espaces une entrée compacte ou indentée autrement', () => {
    const compact = must(removeKey('{"a":1,"b":{"c":2},"z":0}', ['z']))
    expect(compact.text).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}')
    const fourSpaces = must(removeKey('{\n    "a": 1,\n    "z": 0\n}\n', ['z']))
    expect(fourSpaces.text).toBe('{\n  "a": 1\n}\n')
    const tabs = must(removeKey('{\n\t"a": 1,\n\t"z": 0\n}\n', ['z']))
    expect(tabs.text).toBe('{\n  "a": 1\n}\n')
  })

  test('blancs de fin : un seul saut de ligne si l’entrée en avait un, aucun sinon', () => {
    expect(must(removeKey('{"a":1,"z":0}\n\n\n', ['z'])).text).toBe('{\n  "a": 1\n}\n')
    expect(must(removeKey('{"a":1,"z":0}\n   \n', ['z'])).text).toBe('{\n  "a": 1\n}\n')
    expect(must(removeKey('{"a":1,"z":0}   \t', ['z'])).text).toBe('{\n  "a": 1\n}')
    expect(must(removeKey('{"a":1,"z":0}  \n  ', ['z'])).text).toBe('{\n  "a": 1\n}\n')
  })

  test('BOM UTF-8 conservé', () => {
    const out = must(removeKey('﻿{\n  "a": 1,\n  "z": 0\n}\n', ['z']))
    expect(out.text).toBe('﻿{\n  "a": 1\n}\n')
    expect(out.removed).toBe(0)
  })

  test('fins de ligne CRLF conservées, \\n échappé dans une chaîne intact', () => {
    const out = must(removeKey('{\r\n  "a": "x\\ny",\r\n  "z": 0\r\n}\r\n', ['z']))
    expect(out.text).toBe('{\r\n  "a": "x\\ny"\r\n}\r\n')
  })

  test('chaînes Unicode et caractères échappés survivent à la réécriture', () => {
    const out = must(removeKey('{"s": "é — “guillemets” \\"x\\" \\\\", "z": 0}', ['z']))
    expect(JSON.parse(out.text).s).toBe('é — “guillemets” "x" \\')
  })

  test('une clé littéralement nommée __proto__ se retire sans toucher au prototype', () => {
    const out = must(removeKey('{"__proto__": 1, "a": 2}', ['__proto__']))
    expect(out.removed).toBe(1)
    expect(out.text).toBe('{\n  "a": 2\n}')
  })

  test('chemin vide : RangeError', () => {
    expect(() => removeKey(fmt(SETTINGS), [])).toThrow(RangeError)
  })

  test('JSON invalide : SyntaxError, pas null', () => {
    expect(() => removeKey('{"a": 1,}', ['a'])).toThrow(SyntaxError)
    expect(() => removeKey('', ['a'])).toThrow(SyntaxError)
  })
})

describe('setKey', () => {
  test('remplace une clé existante à sa place', () => {
    const out = setKey(fmt({ a: 1, b: 2, c: 3 }), ['b'], 'deux')
    expect(out).toBe(fmt({ a: 1, b: 'deux', c: 3 }))
    expect(Object.keys(JSON.parse(out))).toEqual(['a', 'b', 'c'])
  })

  test('ajoute une clé nouvelle à la fin', () => {
    const out = setKey(fmt({ a: 1, b: 2 }), ['c'], { d: [1] })
    expect(out).toBe(fmt({ a: 1, b: 2, c: { d: [1] } }))
    expect(Object.keys(JSON.parse(out))).toEqual(['a', 'b', 'c'])
  })

  test('crée les objets intermédiaires manquants', () => {
    expect(setKey('{}', ['a', 'b', 'c'], 1)).toBe('{\n  "a": {\n    "b": {\n      "c": 1\n    }\n  }\n}')
    expect(setKey(fmt({ env: {} }), ['env', 'X'], '1')).toBe(fmt({ env: { X: '1' } }))
    expect(setKey(fmt({ a: 1 }), ['x', 'y'], true)).toBe(fmt({ a: 1, x: { y: true } }))
  })

  test('crée un tableau quand le segment suivant est un index : [hooks, Stop, 0]', () => {
    const out = setKey('{}', ['hooks', 'Stop', 0], { command: 'a' })
    expect(JSON.parse(out)).toEqual({ hooks: { Stop: [{ command: 'a' }] } })
    expect(Array.isArray(JSON.parse(out).hooks.Stop)).toBe(true)
  })

  test('pose dans un tableau existant : remplace un index, ajoute à length', () => {
    const json = fmt({ list: ['a', 'b'] })
    expect(JSON.parse(setKey(json, ['list', 1], 'B')).list).toEqual(['a', 'B'])
    expect(JSON.parse(setKey(json, ['list', 2], 'c')).list).toEqual(['a', 'b', 'c']) // index == length : ajout
    expect(JSON.parse(setKey(json, ['list', 0], { k: 1 })).list).toEqual([{ k: 1 }, 'b'])
  })

  test('descend dans un élément de tableau existant', () => {
    const out = setKey(fmt(SETTINGS), ['hooks', 'Stop', 1, 'command'], 'B')
    expect(JSON.parse(out).hooks.Stop).toEqual([{ command: 'a' }, { command: 'B' }])
  })

  test('index hors d’un tableau (au-delà de length, négatif, fractionnaire) : RangeError', () => {
    const json = fmt({ list: ['a'] })
    expect(() => setKey(json, ['list', 3], 'x')).toThrow(RangeError) // créerait des trous
    expect(() => setKey(json, ['list', -1], 'x')).toThrow(RangeError)
    expect(() => setKey(json, ['list', 0.5], 'x')).toThrow(RangeError)
    expect(() => setKey('{}', ['a', 2], 'x')).toThrow(RangeError) // tableau créé vide : seul 0 est permis
  })

  test('segment numérique vers un objet : TypeError (choix documenté dans settings.ts)', () => {
    expect(() => setKey('{"a": {"b": 1}}', ['a', 0], 'x')).toThrow(TypeError)
    expect(() => setKey('{"0": "x"}', [0], 'y')).toThrow(TypeError)
  })

  test('le message d’erreur nomme le chemin fautif et ce qui a été trouvé', () => {
    expect(() => setKey('{"a": {"b": 1}}', ['a', 0], 'x')).toThrow(/un objet, pas un tableau \(chemin \["a",0\]\)/)
    expect(() => setKey('{"a": 5}', ['a', 'b'], 1)).toThrow(/de type number, pas un objet \(chemin \["a","b"\]\)/)
    expect(() => setKey('{"l": []}', ['l', 4], 1)).toThrow(/index 4 hors d’un tableau de 0 éléments/)
  })

  test('segment texte vers un tableau : TypeError', () => {
    expect(() => setKey('{"list": ["a"]}', ['list', '0'], 'x')).toThrow(TypeError)
    expect(() => setKey('{"list": ["a"]}', ['list', 'name'], 'x')).toThrow(TypeError)
  })

  test('un parent scalaire ou null n’est jamais écrasé : TypeError', () => {
    expect(() => setKey('{"a": 5}', ['a', 'b'], 1)).toThrow(TypeError)
    expect(() => setKey('{"a": null}', ['a', 'b'], 1)).toThrow(TypeError)
    expect(() => setKey('{"a": "x"}', ['a', 'b'], 1)).toThrow(TypeError)
    expect(() => setKey('{"a": 5}', ['a', 0], 1)).toThrow(TypeError)
  })

  test('valeur sans forme JSON (undefined, fonction, symbole) : TypeError', () => {
    expect(() => setKey('{}', ['a'], undefined)).toThrow(TypeError)
    expect(() => setKey('{}', ['a'], () => 1)).toThrow(TypeError)
    expect(() => setKey('{}', ['a'], Symbol('x'))).toThrow(TypeError)
  })

  test('null, 0, false et chaîne vide sont des valeurs valides', () => {
    const out = setKey('{}', ['a'], null)
    expect(out).toBe('{\n  "a": null\n}')
    expect(getKey(setKey(out, ['b'], 0), ['b'])).toBe(0)
    expect(getKey(setKey(out, ['b'], false), ['b'])).toBe(false)
    expect(getKey(setKey(out, ['b'], ''), ['b'])).toBe('')
  })

  test('saut de ligne final conservé si et seulement si l’entrée en avait un', () => {
    expect(setKey('{"a":1}\n', ['b'], 2)).toBe('{\n  "a": 1,\n  "b": 2\n}\n')
    expect(setKey('{"a":1}', ['b'], 2)).toBe('{\n  "a": 1,\n  "b": 2\n}')
    expect(setKey('{"a":1}\n\n  ', ['b'], 2)).toBe('{\n  "a": 1,\n  "b": 2\n}\n')
    expect(setKey('{"a":1}  ', ['b'], 2)).toBe('{\n  "a": 1,\n  "b": 2\n}')
  })

  test('BOM UTF-8 et CRLF conservés', () => {
    expect(setKey('﻿{"a":1}\n', ['b'], 2)).toBe('﻿{\n  "a": 1,\n  "b": 2\n}\n')
    expect(setKey('{\r\n  "a": 1\r\n}\r\n', ['b'], 2)).toBe('{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n')
  })

  test('réindente en 2 espaces', () => {
    expect(setKey('{\n    "a": 1\n}\n', ['b'], 2)).toBe('{\n  "a": 1,\n  "b": 2\n}\n')
  })

  test('une clé nommée __proto__ est posée comme une clé ordinaire, sans changer le prototype', () => {
    const out = setKey('{}', ['__proto__'], { polluted: true })
    expect(out).toBe('{\n  "__proto__": {\n    "polluted": true\n  }\n}')
    const parsed: object = JSON.parse(out)
    expect(Object.keys(parsed)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(getKey(out, ['__proto__', 'polluted'])).toBe(true)
  })

  test('chemin vide : RangeError', () => {
    expect(() => setKey('{}', [], 1)).toThrow(RangeError)
  })

  test('JSON invalide : SyntaxError', () => {
    expect(() => setKey('{"a": 1,}', ['a'], 2)).toThrow(SyntaxError)
    expect(() => setKey('', ['a'], 2)).toThrow(SyntaxError)
  })

  test('va-et-vient : retirer puis reposer la dernière clé redonne le texte d’origine', () => {
    const json = fmt({ a: 1, b: { c: [1, 2] } })
    const removed = must(removeKey(json, ['b']))
    expect(setKey(removed.text, ['b'], removed.removed)).toBe(json)
  })

  test('relire ce qu’on vient de poser', () => {
    const value = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "à ‘la’"' }] }
    expect(getKey(setKey(fmt(SETTINGS), ['hooks', 'PreToolUse', 0], value), ['hooks', 'PreToolUse', 0])).toEqual(value)
  })
})
