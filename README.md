# harness

Un plugin Claude Code qui montre **tout ce qui entre dans le contexte** d'une session, et permet de retirer ou d'éditer le non-vanilla **à la source**.

`/harness` ouvre le pane « Harnais » : à gauche l'arbre par source, dans l'ordre où le modèle les reçoit ; à droite le texte exact, le fichier d'origine, le poids approximatif en tokens, et les boutons **Désactiver** / **Modifier**. La status line affiche en permanence `harness: N instr · ≈T tok`.

## Ce qu'il voit

| Groupe | Source | Actions |
|---|---|---|
| Moteur, App et plugins intégrés | sections du system prompt, blocs de contexte | lecture seule (vanilla) |
| CLAUDE.md et règles | chaîne `prompt.context` (ou reconstruction disque), unité par puce ou paragraphe | retirer l'unité ou le fichier ; éditer |
| Mémoire | `MEMORY.md` et les notes du projet | supprimer la note et sa ligne d'index |
| Settings | `settings.json` user / project / local | retirer ou modifier une clé |
| Hooks | `hooks` des settings, `hooks.json` des plugins | retirer l'entrée ; pour un plugin, couper le plugin |
| Plugins | installés, synchronisés claude.ai, en développement | `enabledPlugins` = false |
| Skills et commandes | `~/.claude/skills`, plugins, claude.ai | déplacer vers `skills.disabled/` ; sinon pointeur |
| Serveurs MCP | instructions serveur du system prompt | pointeur vers l'endroit où couper |
| Reminders du tour | `prompt.attachment` | lecture ; pointeur vers le hook producteur |
| Surface | outils et commandes par fournisseur | lecture seule |

## Ce qu'il fait, et ne fait pas

- **Tout à la source.** Désactiver supprime du fichier d'origine ; modifier y écrit. Aucune ombre, aucun overlay : ce que montre le pane est ce que le moteur lit.
- **Journal, pas de corbeille.** Chaque action est consignée dans `~/.claude/harness/journal.md`. Pas de restauration automatique.
- **Périmètre d'écriture** : vos fichiers markdown d'instructions, `settings.json`, `~/.claude/skills/`. Jamais `plugins/cache`, `plugins/synced`, ni la source d'un plugin.
- **Jamais de `prompt.submit`.** Une édition multi-ligne pré-remplit le composer ; vous relisez et envoyez.
- **Un clic agit**, sauf la suppression d'un fichier entier (second clic « Confirmer »).

## Installation

Depuis un terminal :

```bash
/plugin install harness --marketplace yourihamon/harness
```

Ou, pour un dépôt local, ajouter le dossier comme marketplace (`claude plugin marketplace add ~/harness`) puis `claude plugin install harness@harness`.

## Développement

```bash
claude plugin validate .
claude plugin test .
```

`tsc -p .` type-checke une fois que le moteur a posé `.claude-plugin/types/` (au premier chargement du mod). Design et contrats : `DESIGN.md`.
