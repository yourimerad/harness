# harness

Mod Claude Code : pane « Harnais » qui liste tout ce qui entre dans le contexte (system prompt, CLAUDE.md, mémoire, settings, hooks, plugins, skills, MCP, reminders) et permet de retirer ou d'éditer le non-vanilla **à la source**. Décisions et contrats : `DESIGN.md`.

## Carte

- `.claude-plugin/plugin.json` : manifeste ; `types` pointe le contrat d'état.
- `hooks/hooks.json` → `hooks/register.tsx` : le module de hooks (capture, pane, commande, actions).
- `hooks/lib/` : modules purs testés : `markdown.ts` (unités), `settings.ts` (édition JSON), `journal.ts`, `tokens.ts`, `classify.ts`, `model.ts`.
- `types/index.d.ts` : contrat `$.state` (`harness.snapshot`, `harness.ui`).
- `tests/*.test.ts` : `claude plugin test .`.
- `.claude-plugin/types/` : écrit par le moteur, ignoré par git.

## Règles

- Jamais d'écriture hors du périmètre de DESIGN.md §7 ; jamais de `prompt.submit`.
- Toute action à la source passe par le journal `~/.claude/harness/journal.md` avant le toast.
- `claude plugin validate .` et `tsc -p .` doivent passer avant tout commit.
