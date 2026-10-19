# harness — design

Plugin Claude Code (mod à hooks fonctionnels) qui rend visible 100 % de ce qui entre dans le contexte d'une session et permet de tailler le non-vanilla **à la source**. Décisions prises au grill du 2026-10-19.

## Décisions

1. **Observé + reconstruit.** Colonne vertébrale : capture passive de `prompt.compose`, `prompt.context`, `prompt.attachment`, `skill.prompt` (le texte réellement envoyé). Couche disque : rattache chaque élément à son fichier (`instructionFiles`, `settings.json`, `hooks.json` des plugins, dossier `memory/`, `skills/`).
2. **Tout à la source.** Désactiver = supprimer du fichier d'origine. Modifier = écrire dans le fichier. Pas d'ombre, pas d'overlay.
3. **Journal, pas de corbeille.** Chaque action est consignée dans `~/.claude/harness/journal.md` (append-only, lisible). Aucune restauration.
4. **Vanilla** = ce qu'une session recevrait avec un `~/.claude` vide dans cette app : prose du moteur (sections à id nu), prose des plugins intégrés (id `<plugin>:<nom>` dont le plugin n'est pas installé par l'utilisateur), reminders d'origine `engine`. **Non-vanilla** = tout ce qui est traçable à la config de l'utilisateur, claude.ai inclus, le mod lui-même inclus.
5. **UI** : `/harness` ouvre le pane « Harnais » ; status line `harness: N instr · ≈T tok`. Arbre gauche par source dans l'ordre de réception, vanilla replié ; nœud « Surface » (outils, commandes) en lecture seule. Détail droit : texte, chemin, poids, badges, boutons Désactiver / Modifier.
6. **Modifier** : unité mono-ligne → `Input` in-pane, write-through. Multi-ligne → `$.prompt.fill` pré-remplit le composer (« Modifie dans `<fichier>` le bloc “<titre>” : »), jamais de `prompt.submit`.
7. **Périmètre d'écriture directe** : markdown observés (CLAUDE.md / AGENTS.md / rules / memory), `~/.claude/settings.json` (+ `.claude/settings.json` et `.local.json` du projet), `~/.claude/skills/` (déplacement vers `~/.claude/skills.disabled/`). Jamais `plugins/cache/`, `plugins/synced/`, ni la source d'un plugin. Hook de plugin → désactivation du plugin entier (`enabledPlugins`). claude.ai → pointeur.
8. **Confirmation** : un clic agit ; seule la suppression d'un fichier entier demande un second clic (« Confirmer »).
9. **Fraîcheur** : capture par tour ; `$.ui.invalidate` des événements concernés après chaque action ; veille mtime (5 s) tant que le pane est affiché. Au chargement, `$.prompt.compose()` une fois.
10. **Unité markdown** : puce de premier niveau (avec enfants indentés) ou paragraphe hors liste. Titres = conteneurs, retirés quand vides. Frontmatter attaché au fichier. `@import` = unité `import`. Dernière unité retirée → fichier supprimé (+ ligne d'index MEMORY.md pour une note mémoire). Blocs de code / tableaux / citations = unités opaques.
11. **Surface** : outils, commandes et agents par fournisseur, comptes et ≈tokens, lecture seule. Comptés dans la status line.
12. **Vérification** : `claude plugin validate`, `tsc -p`, `claude plugin test` ; comparaison des comptes avec le contexte réel ; round-trip sur un CLAUDE.md jetable.

## Modèle de données (hooks/lib/model.ts)

```ts
type Source =
  | { kind: 'engine' }
  | { kind: 'builtin'; plugin: string }
  | { kind: 'file'; path: string; tier: 'managed' | 'user' | 'project' | 'local' | 'memory' | 'rule' | 'skill' }
  | { kind: 'settings'; path: string; keyPath: string[] }
  | { kind: 'plugin'; name: string; root?: string }
  | { kind: 'mcp'; server: string }
  | { kind: 'claude-ai'; what: string }
  | { kind: 'unknown' }

type Item = {
  id: string            // stable : `${group}/${key}`
  group: GroupId        // 'engine' | 'app' | 'claudeMd' | 'memory' | 'settings' | 'hooks' | 'plugins' | 'skills' | 'mcp' | 'reminders' | 'surface'
  title: string
  text: string          // ce que le modèle lit (ou le texte source pour un fichier)
  tokens: number
  vanilla: boolean
  source: Source
  disable?: Disable     // absent = pas d'action (pointeur dans `hint`)
  edit?: 'inline' | 'prompt'
  hint?: string         // où couper quand le mod ne peut pas
  children?: Item[]     // unités d'un fichier, entrées d'un hook…
}
```

## Contrats des modules purs

### hooks/lib/markdown.ts

```ts
export type UnitKind = 'bullet' | 'paragraph' | 'import' | 'code' | 'table' | 'quote' | 'other'
export type Unit = {
  id: string            // `h<hash8(text)>-<n>` : hash du texte normalisé + rang parmi les doublons → stable entre relectures
  kind: UnitKind
  headingPath: string[] // titres au-dessus, du plus haut au plus proche, sans les `#`
  title: string         // première ligne sans marqueur de liste, ≤ 80 car.
  text: string          // tranche exacte du source, sans saut de ligne final
  start: number         // index de ligne (0-based) de la première ligne
  end: number           // index de ligne après la dernière (exclusif)
  isSingleLine: boolean // une seule ligne, sans enfant → éditable in-pane
}
export type Heading = { level: number; title: string; line: number }
export type ParsedDoc = { frontmatter: string | null; headings: Heading[]; units: Unit[] }

export function parseUnits(text: string): ParsedDoc
/** Retire l'unité ; retire aussi tout titre dont le sous-arbre n'a plus d'unité ; normalise les blancs
 *  (≤ 1 ligne vide consécutive, pas de blancs de fin, saut de ligne final conservé).
 *  `text: null` quand il ne reste que frontmatter / titres / blancs → le fichier est à supprimer. */
export function removeUnit(text: string, unitId: string): { text: string | null; removed: Unit } | null
/** Remplace le texte d'une unité mono-ligne (le marqueur de liste est conservé si `newText` n'en a pas). */
export function replaceUnit(text: string, unitId: string, newText: string): string | null
```

Règles de découpage : une puce de premier niveau commence à la colonne 0 par `- `, `* `, `+ ` ou `1. ` ; ses lignes indentées (≥ 2 espaces ou tab) et ses sous-puces lui appartiennent. Un paragraphe = lignes non vides consécutives hors liste, hors titre, hors fence. Un fence ``` ou ~~~ = unité `code` jusqu'à sa fermeture. Un bloc de lignes commençant par `|` = `table`. Lignes commençant par `>` = `quote`. Une ligne seule `@chemin` = `import`. Le frontmatter `---…---` en tête n'est jamais une unité. Les titres ATX (`#` à `######`) ne sont jamais des unités. Commentaires HTML `<!-- -->` sur leurs propres lignes : unité `other`.

### hooks/lib/settings.ts

```ts
/** Retire la clé au chemin donné (objet ou index de tableau). Conserve l'indentation du fichier (tabulation, ou N espaces d'après la première ligne indentée ; 2 par défaut), le BOM, les CRLF et le saut de ligne final.
 *  Retourne null si le chemin n'existe pas. Ne retire pas les parents devenus vides (le code appelant décide). */
export function removeKey(json: string, keyPath: (string | number)[]): { text: string; removed: unknown } | null
export function setKey(json: string, keyPath: (string | number)[], value: unknown): string
export function getKey(json: string, keyPath: (string | number)[]): unknown
```

### hooks/lib/journal.ts

```ts
export type JournalAction = 'remove-unit' | 'remove-file' | 'edit-unit' | 'remove-key' | 'set-key' | 'disable-plugin' | 'disable-skill' | 'remove-hook'
export type JournalEntry = { at: string; action: JournalAction; target: string; before?: string; after?: string; note?: string }
export function formatEntry(e: JournalEntry): string   // bloc markdown `## <at> · <action> · <target>` + fences ; `\r` seul → `\n` dans note/before/after
```

### hooks/lib/tokens.ts

```ts
export function estimateTokens(text: string): number   // Math.ceil(text.length / 3.5)
export function formatTokens(n: number): string        // '≈ 340' / '≈ 1,2 k' / '≈ 12 k' / '≈ 1,2 M' / '≈ 12 M' ; plafond '≈ 999 M'
```

### hooks/lib/classify.ts

```ts
export function memoryDirFor(home: string, cwd: string): string         // `${home}/.claude/projects/${nom}/memory` ; nom = cwd assaini (/[^A-Za-z0-9]/ → '-'), tronqué comme le moteur au-delà de 200 : 200 premiers + '-' + |hash Java de cwd| en base 36
export function bareName(key: string): string                            // clé `enabledPlugins` → nom nu : partie avant le premier '@'
export function sectionSource(id: string, userPlugins: ReadonlySet<string>): Source   // id nu → engine ; `<p>:<n>` → plugin si p ∈ userPlugins (noms NUS : l'appelant passe bareName(clé)), sinon builtin
export function toolProvider(name: string): { kind: 'engine' | 'mcp'; server?: string } // `mcp__<server>__<tool>`
```

## Flux

- `session.start` : enregistre `/harness`, lit settings + disque, appelle `$.prompt.compose()`, écrit le snapshot, met à jour la status line.
- `prompt.compose` / `prompt.context` / `prompt.attachment` / `skill.prompt` : `next(e)` intact, copie du résultat dans le snapshot.
- `turn.start` : vide la liste des reminders du tour.
- `ui.render` Pane `harness` : construit l'arbre depuis le snapshot + lectures disque mises en cache dans `$.state`.
- Actions : écriture fichier → journal → `$.ui.invalidate('prompt.context' | 'prompt.section' | 'prompt.compose')` → relecture → toast.
