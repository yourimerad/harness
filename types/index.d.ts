// Contrat d'état du mod `harness` : chaque valeur gardée dans `$.state`.
// Importé par hooks/register.tsx ; vérifié par `claude plugin validate`.

export type HarnessSection = { id: string; text: string; scope: 'shared' | 'session' }
export type HarnessBlock = { name: string; text: string }
export type HarnessInstructionFile = { path: string; kind: string; content: string; parent?: string }
export type HarnessAttachment = { type: string; text: string; origin: string; event?: string }
export type HarnessSkillPrompt = { skill: string; text: string; at: string }

export type HarnessSnapshot = {
  /** Horodatage ISO de la dernière capture de sections. */
  at: string
  /** Sections du system prompt telles que `prompt.compose` les a listées. */
  sections: HarnessSection[]
  /** Style de sortie au moment de la composition, ou null. */
  outputStyle: string | null
  /** Blocs de contexte du premier message (`prompt.context`), vides tant que non observés. */
  blocks: HarnessBlock[]
  /** Fichiers d'instructions derrière `claudeMd`, dans l'ordre de rendu ; vide tant que non observé. */
  instructionFiles: HarnessInstructionFile[]
  /** Reminders injectés depuis le début du tour courant (`prompt.attachment`). */
  attachments: HarnessAttachment[]
  /** Prompts de skills chargés cette session (`skill.prompt`). */
  skillPrompts: HarnessSkillPrompt[]
}

export type HarnessSource =
  | { kind: 'engine' }
  | { kind: 'builtin'; plugin: string }
  | { kind: 'file'; path: string; tier: 'managed' | 'user' | 'project' | 'local' | 'memory' | 'rule' | 'skill' | 'agent' }
  | { kind: 'settings'; path: string; keyPath: Array<string | number> }
  | { kind: 'plugin'; name: string; root?: string }
  | { kind: 'mcp'; server: string }
  | { kind: 'claude-ai'; what: string }
  | { kind: 'unknown' }

export type HarnessDisable = {
  kind: 'remove-unit' | 'remove-file' | 'remove-key' | 'disable-plugin' | 'disable-skill' | 'remove-hook'
  path: string
  unitId?: string
  keyPath?: Array<string | number>
  plugin?: string
  /** Fichier d'index (MEMORY.md) dont la ligne pointant `path` est retirée avec le fichier. */
  indexPath?: string
}

export type HarnessItem = {
  id: string
  group: 'engine' | 'app' | 'claudeMd' | 'memory' | 'settings' | 'hooks' | 'plugins' | 'skills' | 'mcp' | 'reminders' | 'surface'
  title: string
  text: string
  tokens: number
  vanilla: boolean
  source: HarnessSource
  disable?: HarnessDisable
  edit?: 'inline' | 'prompt'
  hint?: string
  badges?: string[]
  children?: HarnessItem[]
}

/** Les vues du pane : le résumé, puis une par famille de groupes, puis le journal. */
export type HarnessView = 'overview' | 'instructions' | 'config' | 'skills' | 'mcp' | 'engine' | 'journal'

export type HarnessInventory = {
  /** Horodatage ISO de la construction. */
  builtAt: string
  /** Un item racine par groupe, dans l'ordre de réception. */
  groups: HarnessItem[]
  /** Fichiers sources lus, surveillés par la veille mtime. */
  watched: string[]
  /** Nombre d'instructions non-vanilla (feuilles). */
  count: number
  /** Poids ≈ tokens non-vanilla, surface comprise. */
  tokens: number
  /** Vrai quand la chaîne CLAUDE.md vient de `prompt.context` et non d'une reconstruction disque. */
  observedClaudeMd: boolean
  /** Fin du journal des actions (`~/.claude/harness/journal.md`), par entrées entières ; null sans journal. */
  journal: string | null
}

export type HarnessUi = {
  /** Vue affichée dans le pane. */
  view: HarnessView
  /** Identifiant de l'élément sélectionné dans l'arbre, ou null. */
  selected: string | null
  /** Groupes et nœuds dépliés, par identifiant. */
  expanded: Record<string, boolean>
  /** Élément dont la suppression attend un second clic (fichier entier). */
  confirming: string | null
  /** Élément en cours d'édition in-pane. */
  editing: string | null
  /** Éléments retirés par le mod, en attente de confirmation par la capture suivante. */
  pending: string[]
  /** Chemins des sources modifiées hors du mod depuis la dernière lecture. */
  changedOutside: string[]
  /** Dernier message d'action, affiché dans le pane. */
  notice: string | null
}

declare module 'claude-code' {
  interface PluginState {
    harness: {
      snapshot: HarnessSnapshot | null
      inventory: HarnessInventory | null
      ui: HarnessUi
    }
  }
}
