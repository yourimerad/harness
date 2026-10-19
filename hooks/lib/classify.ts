// Classement des éléments du contexte par provenance. Pur : aucune API Node ni DOM.
import type { Source } from './model'

/** Longueur au-delà de laquelle le moteur tronque le nom de dossier d'un projet. */
const MAX_SANITIZED_LENGTH = 200

/** `String.hashCode()` de Java sur les unités UTF-16 : entier 32 bits signé, comme le calcule le moteur. */
function javaHashCode(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0
  return h
}

/**
 * Dossier mémoire d'un projet : `<home>/.claude/projects/<cwd assaini>/memory`.
 * L'assainissement remplace chaque caractère hors [A-Za-z0-9] par `-` (chaque unité UTF-16, comme le moteur).
 * Au-delà de 200 caractères, le moteur tronque : les 200 premiers, puis `-` et le hash Java de `cwd` (le chemin
 * d'origine, pas l'assaini) en valeur absolue, en base 36 — deux longs chemins au même début restent distincts.
 * Les `/` en fin de `home` sont ignorés.
 */
export function memoryDirFor(home: string, cwd: string): string {
  const root = home.replace(/\/+$/, '')
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const name =
    sanitized.length <= MAX_SANITIZED_LENGTH
      ? sanitized
      : `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(javaHashCode(cwd)).toString(36)}`
  return `${root}/.claude/projects/${name}/memory`
}

/**
 * Nom nu d'un plugin à partir de sa clé (`enabledPlugins`, `hcc@local`) : la partie avant le premier `@`
 * (`hcc@local` → `hcc`, `hcc` → `hcc`). Une clé qui commence par `@` donne `''`.
 */
export function bareName(key: string): string {
  const at = key.indexOf('@')
  return at === -1 ? key : key.slice(0, at)
}

/**
 * Provenance d'une section du system prompt d'après son id.
 * - id nu (`intro`) : prose du moteur ;
 * - `<plugin>:<nom>` : plugin de l'utilisateur si `<plugin>` est dans `userPlugins`, sinon plugin intégré à l'app ;
 * - l'id se coupe au premier `:` (`a:b:c` → plugin `a`) ;
 * - préfixe vide (`:x`) : id mal formé, donc `unknown`.
 *
 * `userPlugins` contient des noms NUS de plugins (`hcc`), sans `@marketplace` : l'id d'une section n'en porte
 * jamais, donc `hcc@local` ne correspondrait à rien. L'appelant passe `bareName(clé)` pour chaque clé
 * (`new Set(clés.map(bareName))`).
 */
export function sectionSource(id: string, userPlugins: ReadonlySet<string>): Source {
  const colon = id.indexOf(':')
  if (colon === -1) return { kind: 'engine' }
  if (colon === 0) return { kind: 'unknown' }
  const plugin = id.slice(0, colon)
  return userPlugins.has(plugin) ? { kind: 'plugin', name: plugin } : { kind: 'builtin', plugin }
}

/**
 * Fournisseur d'un outil : `mcp__<serveur>__<outil>` → `{ kind: 'mcp', server }`, le reste → moteur.
 * Le serveur va jusqu'au premier `__` après le préfixe (`mcp__plugin_small-business_gmail__get_message`
 * → `plugin_small-business_gmail`). Un nom `mcp__…` sans serveur ou sans outil n'est pas un outil MCP : moteur.
 */
export function toolProvider(name: string): { kind: 'engine' } | { kind: 'mcp'; server: string } {
  const prefix = 'mcp__'
  if (!name.startsWith(prefix)) return { kind: 'engine' }
  const sep = name.indexOf('__', prefix.length)
  // sep === prefix.length : serveur vide ; sep + 2 === name.length : outil vide.
  if (sep <= prefix.length || sep + 2 >= name.length) return { kind: 'engine' }
  return { kind: 'mcp', server: name.slice(prefix.length, sep) }
}
