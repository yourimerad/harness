// Modèle de données du mod harness (voir DESIGN.md, « Modèle de données »).
// Types seulement : aucun code à l'exécution.

/** D'où vient un élément du contexte : sert à décider s'il est vanilla et où le couper. */
export type Source =
  | { kind: 'engine' }
  | { kind: 'builtin'; plugin: string }
  | { kind: 'file'; path: string; tier: 'managed' | 'user' | 'project' | 'local' | 'memory' | 'rule' | 'skill' }
  | { kind: 'settings'; path: string; keyPath: string[] }
  | { kind: 'plugin'; name: string; root?: string }
  | { kind: 'mcp'; server: string }
  | { kind: 'claude-ai'; what: string }
  | { kind: 'unknown' }

/** Groupes de premier niveau de l'arbre « Harnais ». */
export type GroupId =
  | 'engine'
  | 'app'
  | 'claudeMd'
  | 'memory'
  | 'settings'
  | 'hooks'
  | 'plugins'
  | 'skills'
  | 'mcp'
  | 'reminders'
  | 'surface'

/** Comment retirer un élément à la source. Un seul `kind` par action ; les champs utiles dépendent du `kind`. */
export type Disable = {
  kind: 'remove-unit' | 'remove-file' | 'remove-key' | 'disable-plugin' | 'disable-skill' | 'remove-hook'
  /** Fichier touché par l'action. */
  path: string
  /** `remove-unit` : identifiant de l'unité markdown à retirer. */
  unitId?: string
  /** `remove-key` / `remove-hook` : chemin de la clé dans le JSON du fichier. */
  keyPath?: (string | number)[]
  /** `disable-plugin` / `disable-skill` : nom du plugin concerné. */
  plugin?: string
}

/** Un nœud de l'arbre : un bloc de contexte, un fichier, une unité de fichier, une entrée de hook… */
export type Item = {
  /** Stable : `${group}/${key}`. */
  id: string
  group: GroupId
  title: string
  /** Ce que le modèle lit (ou le texte source pour un fichier). */
  text: string
  tokens: number
  vanilla: boolean
  source: Source
  /** Absent = pas d'action (le pointeur est dans `hint`). */
  disable?: Disable
  edit?: 'inline' | 'prompt'
  /** Où couper quand le mod ne peut pas. */
  hint?: string
  /** Unités d'un fichier, entrées d'un hook… */
  children?: Item[]
}
