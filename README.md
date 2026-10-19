# harness

Un plugin Claude Code qui montre **tout ce qui entre dans le contexte** d'une session, et permet de retirer ou d'éditer le non-vanilla **à la source**.

`/harness` ouvre le pane « Harnais » sur un **Résumé** : une ligne par source avec sa barre de poids, ses tokens et son compte non-vanilla ; un clic ouvre la vue correspondante. Les vues, en barre (touches 1 à 7 quand le pane a le focus, ou `/harness journal`, `/harness 3`, `/harness régl`…) :

| Vue | Contenu |
|---|---|
| Résumé | poids et comptes par source, état de la capture, relecture du disque |
| Instructions | CLAUDE.md, règles, mémoire |
| Réglages | settings.json, hooks, plugins |
| Skills | skills, commandes, agents |
| MCP & outils | serveurs MCP, outils et commandes (lecture seule) |
| Moteur | sections vanilla, blocs du premier message, reminders observés |
| Journal | la fin de `journal.md`, en markdown |

Dans une vue : à gauche l'arbre des groupes concernés, dans l'ordre où le modèle les reçoit ; à droite le texte exact, le fichier d'origine, le poids en tokens, et les boutons **Désactiver** / **Modifier**. Dans un pane étroit (terminal sur l'écran principal), l'arbre et le détail s'empilent. La status line affiche en permanence `harness: N instr · ≈T tok`.

## Ce qu'il voit

| Groupe | Source | Actions |
|---|---|---|
| Moteur, App et plugins intégrés | sections du system prompt, blocs de contexte | lecture seule (vanilla) |
| CLAUDE.md et règles | chaîne `prompt.context` (ou reconstruction disque), unité par puce ou paragraphe | retirer l'unité ou le fichier ; éditer |
| Mémoire | `MEMORY.md` et les notes du projet | supprimer la note et sa ligne d'index |
| Settings | `settings.json` user / project / local ; le style de sortie actif (marqueur observé, sinon nom donné par `prompt.compose` + fichier du style sur disque ; style intégré : poids estimé par sa taille connue) | retirer ou modifier une clé ; éditer le fichier du style |
| Hooks | `hooks` des settings, `hooks.json` des plugins | retirer l'entrée ; pour un plugin, couper le plugin |
| Plugins | installés, synchronisés claude.ai, en développement | `enabledPlugins` = false |
| Skills et commandes | `~/.claude/skills`, plugins, claude.ai ; agents personnalisés (mesurés par /context) | déplacer vers `skills.disabled/` ; sinon pointeur |
| Serveurs MCP | instructions serveur quand un marqueur les porte (section, premier message, reminder) ; sans marqueur, badge « instructions non observables » et poids total mesuré par /context | pointeur vers l'endroit où couper |
| Reminders du tour | `prompt.attachment` | lecture ; pointeur vers le hook producteur |
| Surface | outils et commandes par fournisseur, poids mesurés par /context (outil MCP chargé ou différé) | lecture seule |

## Ce qu'il fait, et ne fait pas

- **Tout à la source.** Désactiver supprime du fichier d'origine ; modifier y écrit. Aucune ombre, aucun overlay : ce que montre le pane est ce que le moteur lit.
- **Journal, pas de corbeille.** Chaque action est consignée dans `~/.claude/harness/journal.md`. Pas de restauration automatique.
- **Périmètre d'écriture** : vos fichiers markdown d'instructions, `settings.json`, `~/.claude/skills/`. Jamais `plugins/cache`, `plugins/synced`, ni la source d'un plugin.
- **Jamais de `prompt.submit`.** Une édition multi-ligne pré-remplit le composer ; vous relisez et envoyez.
- **Un clic agit**, sauf la suppression d'un fichier entier (second clic « Confirmer »).

## Limites

Ce que le mod ne voit pas, ou voit en partie, et pourquoi. Vérifiable dans `~/.claude/harness/inventory.json` (`sessionId`, `sections`, `blocks`, `attachments`, `groups`), réécrit à chaque reconstruction.

- **La prose ajoutée par l'hôte.** Sous l'app de bureau (SDK, preset `claude_code` + `systemPrompt.append`), le system prompt reçu par le modèle contient, après les sections, une longue prose de l'app : règles du Code tab, sessions liées, navigateurs, simulateur iOS, mode WebSearch, règles de sécurité pour l'usage de l'ordinateur. Ce n'est pas une section de `prompt.compose` et aucun hook ne la lit. Le pane la signale par différence, dans « App », quand /context compte nettement plus de system prompt que les sections ne pèsent (« prose du system prompt hors sections ») ; elle n'est ni listée ni coupable.
- **Les sections par personne du preset SDK.** Sous ce preset, l'environnement d'invocation, le style de sortie, la liste des outils différés, les types d'agents, les instructions MCP, la liste des skills, le mode auto et la date ne sont pas des sections : ils voyagent avec le premier message, promus en tour système. Observé sur une session neuve de l'app de bureau (2026-10-19, build 2.1.295) : `prompt.context` ne porte que `claudeMd`, `userEmail` et `currentDate` ; `prompt.attachment` ne porte que les reminders de tour (`output_style`, `remote_session_change`) ; ce bloc, comme les notices de l'app (attribution des commits, dossier de travail), ne passe par aucun des deux, et `$.session.messages` ne le porte pas non plus. Il est donc invisible au pane ; seul son poids est dans la mesure /context. Les marqueurs (`# Output Style:`, `# MCP Server Instructions`, `# Memory`) sont cherchés dans les blocs et les reminders quand même, pour un hôte qui les y passerait (en terminal, le style et les instructions MCP sont des sections). Deux compléments sans marqueur. Le **style de sortie** : le nom actif vient de `prompt.compose` (null = style par défaut, rien à montrer ; sans compose observé, de `settings.outputStyle`), le texte du fichier du style quand il est sur disque (nom effectif = `name:` du frontmatter sinon nom du fichier, casse comprise ; `.claude/output-styles` du dossier de travail à la racine du projet, puis `~/.claude/output-styles`, puis `output-styles/` d'un plugin pour `plugin:nom`) ; un style intégré n'a pas de texte lisible et son poids est estimé d'après sa taille dans le build 2.1.295 (Concise 1 349 car., Explanatory 1 470, Learning 5 400), inconnu sinon ; la clé à retirer est celle de la source settings la plus haute qui porte ce nom, un style imposé par un plugin ou une politique n'a pas de bouton. Les **instructions MCP** : aucun noun de cette version n'expose le texte d'un serveur (`$.tool.list` donne une première phrase, `$.mcp` appelle, la ventilation /context n'a pas le détail par serveur), mais /context en mesure le poids total (catégorie « MCP server instructions ») : le pane l'affiche dans un item « instructions MCP », et un serveur dont le texte n'a pas été vu porte « instructions non observables » quand aucun marqueur n'a été observé (sans marqueur, on ne sait pas ; avec un marqueur, un serveur absent n'en envoie pas : « sans instructions »). Sur une session de bureau mesurée le 2026-10-19, 4 serveurs sur 36 en envoyaient, ≈ 7 400 caractères ; les deltas d'un serveur connecté plus tard restent à vérifier.
- **Un attachment n'est demandé qu'une fois par processus.** Un mod chargé en cours de session (hot reload) ne voit ni les blocs du premier message ni les reminders déjà rendus avant lui ; la chaîne CLAUDE.md est alors reconstruite depuis le disque (badge `reconstruit`), et /context dit quels fichiers sont réellement chargés. Seule une session neuve capture tout.
- **Les poids sont des mesures quand /context les donne, des estimations sinon.** Sans ventilation, un outil MCP est compté comme différé (nom seul), un outil du moteur comme décrit en entier, et chaque skill comme listé en entier alors que le moteur borne ce listing à un budget. `$.tool.list()` ne dit pas quel outil du moteur est derrière ToolSearch ; `ToolInfo.description` d'un outil MCP n'est qu'une première phrase.
- **Un export par `~/.claude`.** Deux sessions qui tournent avec le mod écrivent le même `inventory.json` : la dernière reconstruction l'emporte ; `sessionId` et `cwd` disent laquelle.
- **Les agents personnalisés sont hors périmètre d'écriture.** Un fichier `~/.claude/agents/*.md` ou `.claude/agents/*.md` est listé avec son poids et un pointeur, pas un bouton.
- **Un plugin d'une marketplace locale est lu depuis son dossier.** `claude plugin install` laisse une copie dans `~/.claude/plugins/cache/`, mais pour une marketplace de type `directory` le moteur lit la source (`claude plugin list` : « Read from ») : une modification agit à la session suivante ou à `/reload-plugins`, sans `claude plugin update` (qui répond « nothing to update »). Le pane montre ce dossier (badge « lu depuis son dossier »). Le moteur ne pose `.claude-plugin/types/` que pour un mod chargé par `--plugin-dir` ou hot reload.

## Installation

Depuis un terminal :

```bash
/plugin install harness --marketplace yourimerad/harness
```

Ou, pour un dépôt local, ajouter le dossier comme marketplace (`claude plugin marketplace add ~/harness`) puis `claude plugin install harness@harness`.

## Développement

```bash
claude plugin validate .
claude plugin test .
```

`tsc -p .` type-checke une fois que le moteur a posé `.claude-plugin/types/` (au premier chargement du mod depuis son dossier : `--plugin-dir`, hot reload). Pour un plugin installé (même lu depuis son dossier), il n'est pas posé : type-checker avec un `tsconfig.json` hors du dépôt (options du haut de `claude-code.d.ts`, que le skill `plugin-authoring` écrit sous `/tmp/claude-<uid>/bundled-skills/<version>/…/plugin-authoring/types/`) dont `include` nomme ce fichier et `hooks`, `types`, `tests` du dépôt. Design et contrats : `DESIGN.md`.
