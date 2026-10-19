# harness

Mod Claude Code : pane « Harnais » qui liste tout ce qui entre dans le contexte (system prompt, CLAUDE.md, mémoire, settings, hooks, plugins, skills, MCP, reminders) et permet de retirer ou d'éditer le non-vanilla **à la source**. Décisions et contrats : `DESIGN.md`. Usage : `README.md`.

## Carte

- `.claude-plugin/plugin.json` : manifeste ; `types` pointe le contrat d'état.
- `hooks/hooks.json` → `hooks/register.tsx` : le seul fichier qui touche `$` (capture passive, commande `/harness`, veille mtime, câblage des actions) ; il construit des objets `io` pour les modules.
- `hooks/pane.tsx` : rendu pur du pane à partir du modèle et de la table d'éléments résolue.
- `hooks/lib/inventory.ts` : construit l'arbre d'items (snapshot + disque + ventilation /context via `InventoryIo`) ; les marqueurs sont cherchés dans sections, blocs et reminders.
- `hooks/lib/actions.ts` : actions à la source (via `ActionIo`), journal, périmètre d'écriture.
- `hooks/lib/` purs testés : `markdown.ts` (unités), `settings.ts` (JSON), `journal.ts`, `tokens.ts`, `classify.ts`, `model.ts` (renomme les types du contrat).
- `types/index.d.ts` : contrat `$.state` (`harness.snapshot`, `harness.inventory`, `harness.ui`) et types partagés.
- `tests/*.test.ts` : `claude plugin test .` ; `tests/fixtures.ts` = un `~/.claude` fictif partagé ; `pane.test.ts` joue session.start → inventaire → rendu → action dans le kit.
- `.claude-plugin/types/` : écrit par le moteur, ignoré par git.

## Règles

- `$` ne traverse jamais un import (le validateur le refuse) : tout appel `$.noun.method` vit dans `register.tsx`, les modules reçoivent `io`.
- Aucun paramètre ni variable nommé `h` dans un fichier qui écrit du JSX (c'est la fabrique).
- Un hook de test qui répond à un appel de noun renvoie `{ value }` ; un événement renvoie son résultat.
- Jamais d'écriture hors du périmètre de DESIGN.md §7 ; jamais de `prompt.submit` ; journal avant toast.
- `claude plugin validate .`, `tsc -p .` et `claude plugin test .` passent avant tout commit.
