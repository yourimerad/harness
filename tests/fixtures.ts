// Fixtures partagées : un ~/.claude fictif, les commandes et outils d'une session, un snapshot de sections.
import type { HarnessSnapshot as Snapshot } from '../types'
import type { InventoryIo } from '../hooks/lib/inventory'

export const HOME = '/Users/y'
export const CWD = '/Users/y/proj'
export const env = { home: HOME, cwd: CWD, root: CWD, now: '2026-10-19T10:00:00.000Z' }
export const MEM = `${HOME}/.claude/projects/-Users-y-proj/memory`
export const HCC = `${HOME}/.claude/plugins/cache/hcc/hcc/0.2.2`

export const FILES: Record<string, string> = {
  [`${HOME}/.claude/CLAUDE.md`]: '# Contexte\n\n## Machine\n- Locale française.\n- Secrets via `$VAR`.\n\n## Code\n- Stack TypeScript.\n',
  [`${HOME}/.claude/settings.json`]: JSON.stringify({
    outputStyle: 'Concise', model: 'opus', effortLevel: 'xhigh',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
    enabledPlugins: { 'hcc@hcc': true }, theme: 'dark',
  }, null, 2),
  [`${HOME}/.claude/plugins/installed_plugins.json`]: JSON.stringify({ version: 2, plugins: { 'hcc@hcc': [{ scope: 'user', installPath: HCC, version: '0.2.2' }] } }),
  [`${HCC}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'hcc', version: '0.2.2', description: 'dox' }),
  [`${HCC}/hooks/hooks.json`]: JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dox-session.js"' }] }], PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node x.js' }] }] } }),
  [`${MEM}/MEMORY.md`]: '- [Pin worktree](pin.md) — isolation des sous-agents\n',
  [`${MEM}/pin.md`]: '---\nname: pin\n---\n\nToujours un worktree.\n',
  [`${MEM}/orpheline.md`]: 'Note sans index.\n',
  [`${HOME}/.claude/skills/grilling/SKILL.md`]: '---\nname: grilling\n---\n\nGrille.\n',
  [`${HOME}/.claude.json`]: JSON.stringify({ mcpServers: { 'multi-gmail': {} } }),
}
export const DIRS: Record<string, string[]> = {
  [`${HOME}/.claude/plugins/synced`]: ['.bucket', 'bucket1'],
  [`${HOME}/.claude/dev-mods`]: [],
  [`${HOME}/.claude/rules`]: [],
  [MEM]: ['MEMORY.md', 'pin.md', 'orpheline.md'],
  [`${HCC}/skills`]: ['dox', 'dox-pass'],
  [`${HCC}/commands`]: [],
  [`${HCC}/agents`]: ['dox-updater.md'],
}

export const io = (files = FILES, dirs = DIRS, usage: InventoryIo['usage'] = async () => null): InventoryIo => ({
  readText: async path => files[path] ?? null,
  list: async path => dirs[path] ?? [],
  exists: async path => path in files || path in dirs,
  pluginDirs: async () => undefined,
  ancestors: async () => [],
  commands: async () => [
    { name: 'compact', description: 'Compacter', source: 'builtin' as const },
    { name: 'grilling', description: 'Griller un plan', source: 'user' as const },
    { name: 'hcc:dox-pass', description: 'Passe dox', source: 'plugin' as const, plugin: 'hcc' },
    { name: 'anthropic-skills:pdf', description: 'PDF', source: 'plugin' as const, plugin: 'anthropic-skills' },
    { name: 'ccd:tasks', description: 'tâches', source: 'plugin' as const, plugin: 'ccd' },
  ],
  tools: async () => [
    { name: 'Bash', description: 'Exécute une commande', mcp: false },
    { name: 'mcp__vercel__list_projects', description: 'Liste', mcp: true },
    { name: 'mcp__vercel__get_project', description: 'Lit', mcp: true },
  ],
  usage,
})

/** Une ventilation /context comme `$.session.usage({ breakdown: 'summary' })` la rend. */
export const BREAKDOWN: NonNullable<Awaited<ReturnType<InventoryIo['usage']>>> = {
  categories: [
    { name: 'System prompt', tokens: 9000, kind: 'used' },
    { name: 'System tools', tokens: 1500, kind: 'used' },
    { name: 'MCP tools', tokens: 700, kind: 'used' },
    { name: 'Free space', tokens: 100000, kind: 'free' },
  ],
  memoryFiles: [
    { path: `${HOME}/.claude/CLAUDE.md`, type: 'User', tokens: 60 },
    { path: `${HOME}/.claude/rules/extra.md`, type: 'User', tokens: 10 },
    { path: `${MEM}/MEMORY.md`, type: 'AutoMem', tokens: 20 },
  ],
  mcpTools: [
    { name: 'mcp__vercel__list_projects', serverName: 'Vercel', tokens: 300, isLoaded: true },
    { name: 'mcp__vercel__get_project', serverName: 'Vercel', tokens: 400, isLoaded: false },
    { name: 'mcp__claude_ai_Gmail__search', serverName: 'claude.ai Gmail', tokens: 250, isLoaded: true },
  ],
  agents: [
    { agentType: 'hcc:dox-updater', source: 'plugin', tokens: 40 },
    { agentType: 'seo:auditor', source: 'plugin', tokens: 30 },
    { agentType: 'reviewer', source: 'userSettings', tokens: 25 },
  ],
  skills: {
    totalSkills: 4, includedSkills: 2, tokens: 90,
    skillFrontmatter: [
      { name: 'grilling', source: 'userSettings', tokens: 50 },
      { name: 'hcc:dox-pass', source: 'plugin', pluginName: 'hcc', tokens: 40 },
    ],
  },
  slashCommands: { totalCommands: 5, includedCommands: 5, tokens: 30 },
}

export const SNAP: Snapshot = {
  at: '', outputStyle: 'Concise', blocks: [{ name: 'currentDate', text: '2026-10-19' }], instructionFiles: [], attachments: [], skillPrompts: [],
  sections: [
    { id: 'intro', text: 'You are Claude Code.', scope: 'shared' },
    { id: 'ccd:tasks', text: 'Task list rules.', scope: 'session' },
    { id: 'hcc:policy', text: 'dox policy', scope: 'session' },
    { id: 'memory', text: `# Memory\n\nYou have a persistent file-based memory at \`${MEM}/\`.`, scope: 'session' },
    { id: 'mcp', text: '# MCP Server Instructions\n\nThe following servers…\n\n## vercel\nUse tool schemas.\n\n## multi-gmail\nGmail.', scope: 'session' },
    { id: 'style', text: '# Output Style: Concise\n\nKeep it short.', scope: 'session' },
  ],
}

