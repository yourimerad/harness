// Classement des éléments du contexte par provenance. Pur : aucune API Node ni DOM.
import type { Source } from './model'

/**
 * Dossier mémoire d'un projet : `<home>/.claude/projects/<cwd assaini>/memory`.
 * L'assainissement remplace chaque caractère hors [A-Za-z0-9] par `-` (chaque unité UTF-16, comme le moteur).
 * Les `/` en fin de `home` sont ignorés. Limite : ne reproduit pas une éventuelle troncature des très longs chemins.
 */
export function memoryDirFor(home: string, cwd: string): string {
  const root = home.replace(/\/+$/, '')
  return `${root}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/memory`
}

/**
 * Provenance d'une section du system prompt d'après son id.
 * - id nu (`intro`) : prose du moteur ;
 * - `<plugin>:<nom>` : plugin de l'utilisateur si `<plugin>` est dans `userPlugins`, sinon plugin intégré à l'app ;
 * - l'id se coupe au premier `:` (`a:b:c` → plugin `a`) ;
 * - préfixe vide (`:x`) : id mal formé, donc `unknown`.
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
