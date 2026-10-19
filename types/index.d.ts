// Contrat d'état du mod `harness` : chaque valeur gardée dans `$.state`.
// Importé par hooks/register.tsx ; vérifié par `claude plugin validate`.

export type HarnessSnapshot = {
  /** Horodatage ISO de la dernière capture. */
  at: string
  /** Sections du system prompt telles que `prompt.compose` les a listées. */
  sections: Array<{ id: string; text: string; scope: 'shared' | 'session' }>
  /** Blocs de contexte du premier message (`prompt.context`). */
  blocks: Array<{ name: string; text: string }>
  /** Fichiers d'instructions derrière `claudeMd`, dans l'ordre de rendu. */
  instructionFiles: Array<{ path: string; kind: string; content: string; parent?: string }>
  /** Reminders injectés depuis le début du tour courant (`prompt.attachment`). */
  attachments: Array<{ type: string; text: string; origin: string; event?: string }>
  /** Prompts de skills chargés cette session (`skill.prompt`). */
  skillPrompts: Array<{ skill: string; text: string; at: string }>
}

export type HarnessUi = {
  /** Identifiant de l'élément sélectionné dans l'arbre, ou null. */
  selected: string | null
  /** Groupes dépliés, par identifiant de groupe. */
  expanded: Record<string, boolean>
  /** Élément dont la suppression attend un second clic (fichier entier). */
  confirming: string | null
  /** Éléments retirés par le mod, en attente de confirmation par la capture suivante. */
  pending: string[]
  /** Chemins des sources modifiées hors du mod depuis la dernière lecture. */
  changedOutside: string[]
  /** Compteur de rafraîchissements forcés (relecture disque). */
  tick: number
}

declare module 'claude-code' {
  interface PluginState {
    harness: {
      snapshot: HarnessSnapshot | null
      ui: HarnessUi
    }
  }
}
