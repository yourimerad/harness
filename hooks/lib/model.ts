// Modèle de données du mod harness : les types vivent dans le contrat `types/index.d.ts`
// (une seule source de vérité, lue aussi par `claude plugin validate`) ; ce module les renomme.
import type { HarnessDisable, HarnessItem, HarnessSource } from '../../types'

export type Source = HarnessSource
export type Disable = HarnessDisable
export type Item = HarnessItem
/** Groupes de premier niveau de l'arbre « Harnais ». */
export type GroupId = HarnessItem['group']
