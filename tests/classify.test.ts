import { test, expect, describe } from 'claude-code/testing'
import { bareName, memoryDirFor, sectionSource, toolProvider } from '../hooks/lib/classify'

describe('memoryDirFor', () => {
  test('exemple du contrat : chaque caractère hors [A-Za-z0-9] devient « - »', () => {
    expect(memoryDirFor('/Users/y', '/Users/y/Library/Application Support/Claude/x')).toBe(
      '/Users/y/.claude/projects/-Users-y-Library-Application-Support-Claude-x/memory',
    )
  })

  test('points, tirets bas, tirets et espaces sont remplacés un par un', () => {
    expect(memoryDirFor('/h', '/a.b_c-d e')).toBe('/h/.claude/projects/-a-b-c-d-e/memory')
    expect(memoryDirFor('/h', '/p/.worktrees/feat')).toBe('/h/.claude/projects/-p--worktrees-feat/memory')
  })

  test('les chiffres et les majuscules sont gardés', () => {
    expect(memoryDirFor('/h', '/Abc/XYZ/0189')).toBe('/h/.claude/projects/-Abc-XYZ-0189/memory')
  })

  test('chaque caractère non ASCII compte pour un « - » par unité UTF-16', () => {
    expect(memoryDirFor('/h', '/café')).toBe('/h/.claude/projects/-caf-/memory')
    expect(memoryDirFor('/h', '/a😀b')).toBe('/h/.claude/projects/-a--b/memory') // 😀 = 2 unités UTF-16
  })

  test('chemin Windows : séparateurs et deux-points remplacés', () => {
    expect(memoryDirFor('C:\\Users\\y', 'C:\\Users\\y\\proj')).toBe('C:\\Users\\y/.claude/projects/C--Users-y-proj/memory')
  })

  test('les « / » en fin de home ne produisent pas de double barre', () => {
    expect(memoryDirFor('/Users/y/', '/p')).toBe('/Users/y/.claude/projects/-p/memory')
    expect(memoryDirFor('/Users/y///', '/p')).toBe('/Users/y/.claude/projects/-p/memory')
    expect(memoryDirFor('/', '/p')).toBe('/.claude/projects/-p/memory')
  })

  test('le cwd est assaini tel quel, un « / » final devient un « - » final', () => {
    expect(memoryDirFor('/h', '/p/')).toBe('/h/.claude/projects/-p-/memory')
  })
})

describe('memoryDirFor : troncature des longs chemins (comme le moteur)', () => {
  /** Même formule que le moteur, écrite ici en ligne (String.hashCode de Java sur les unités UTF-16). */
  const expectedDir = (home: string, cwd: string): string => {
    const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    let name = sanitized
    if (sanitized.length > 200) {
      let h = 0
      for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0
      name = `${sanitized.slice(0, 200)}-${Math.abs(h).toString(36)}`
    }
    return `${home}/.claude/projects/${name}/memory`
  }

  test('exactement 200 caractères assainis : pas de troncature, pas de suffixe', () => {
    const cwd = '/' + 'a'.repeat(199) // « - » + 199 « a » = 200
    expect(memoryDirFor('/h', cwd)).toBe(`/h/.claude/projects/-${'a'.repeat(199)}/memory`)
  })

  test('201 caractères assainis : 200 premiers, puis « - » et le hash Java en base 36', () => {
    const cwd = '/' + 'a'.repeat(200) // 201 caractères
    const dir = memoryDirFor('/h', cwd)
    expect(dir).toBe(`/h/.claude/projects/-${'a'.repeat(199)}-b6ymvl/memory`) // suffixe figé en dur
    expect(dir).toBe(expectedDir('/h', cwd)) // et recalculé avec la formule du moteur
  })

  test('suffixe figé pour un chemin long réaliste (300 caractères)', () => {
    const cwd = '/Users/youri/' + 'projets-longs/'.repeat(20) + 'harness'
    expect(cwd.length).toBe(300)
    const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    expect(memoryDirFor('/Users/youri', cwd)).toBe(`/Users/youri/.claude/projects/${sanitized.slice(0, 200)}-9lwgnr/memory`)
    expect(memoryDirFor('/Users/youri', cwd)).toBe(expectedDir('/Users/youri', cwd))
  })

  test('le hash porte sur le chemin d’origine : deux chemins qui s’assainissent pareil restent distincts', () => {
    const a = '/' + 'a.'.repeat(150)
    const b = '/' + 'a_'.repeat(150)
    expect(a.replace(/[^a-zA-Z0-9]/g, '-')).toBe(b.replace(/[^a-zA-Z0-9]/g, '-'))
    expect(memoryDirFor('/h', a)).not.toBe(memoryDirFor('/h', b))
    expect(memoryDirFor('/h', a)).toBe(expectedDir('/h', a))
    expect(memoryDirFor('/h', b)).toBe(expectedDir('/h', b))
  })

  test('hash négatif : valeur absolue (le suffixe ne contient pas de « - » en plus)', () => {
    const cwd = '/' + 'a'.repeat(200) // hash Java -676821585
    const suffix = memoryDirFor('/h', cwd).split('-').pop() as string
    expect(suffix).toBe('b6ymvl/memory')
  })

  test('caractères non ASCII : le hash porte sur les unités UTF-16 du chemin d’origine', () => {
    const cwd = '/' + 'é😀'.repeat(120) // 361 unités UTF-16, hash Java 541367087
    expect(memoryDirFor('/h', cwd)).toBe(`/h/.claude/projects/${'-'.repeat(200)}-8ybdin/memory`)
    expect(memoryDirFor('/h', cwd)).toBe(expectedDir('/h', cwd))
  })

  test('un chemin de 109 caractères n’est pas suffixé', () => {
    const cwd = '/Users/y/' + 'x'.repeat(100)
    expect(memoryDirFor('/h', cwd)).toBe(`/h/.claude/projects/-Users-y-${'x'.repeat(100)}/memory`)
  })
})

describe('bareName', () => {
  test('coupe au premier « @ » : la marketplace est retirée', () => {
    expect(bareName('hcc@local')).toBe('hcc')
    expect(bareName('searchfit-seo@searchfit')).toBe('searchfit-seo')
    expect(bareName('a@b@c')).toBe('a')
  })

  test('une clé sans « @ » est rendue telle quelle', () => {
    expect(bareName('hcc')).toBe('hcc')
    expect(bareName('')).toBe('')
  })

  test('une clé qui commence par « @ » donne une chaîne vide', () => {
    expect(bareName('@local')).toBe('')
  })

  test('avec sectionSource : la clé de enabledPlugins ne correspond qu’une fois passée par bareName', () => {
    const keys = ['hcc@local', 'small-business@claude-plugins']
    expect(sectionSource('hcc:policy', new Set(keys))).toEqual({ kind: 'builtin', plugin: 'hcc' }) // clé brute : ne trouve rien
    expect(sectionSource('hcc:policy', new Set(keys.map(bareName)))).toEqual({ kind: 'plugin', name: 'hcc' })
  })
})

describe('sectionSource', () => {
  const user = new Set(['hcc'])

  test('id nu : prose du moteur', () => {
    expect(sectionSource('intro', user)).toEqual({ kind: 'engine' })
    expect(sectionSource('tone_and_style', new Set())).toEqual({ kind: 'engine' })
  })

  test('<plugin>:<nom> d’un plugin de l’utilisateur : plugin', () => {
    expect(sectionSource('hcc:policy', user)).toEqual({ kind: 'plugin', name: 'hcc' })
  })

  test('<plugin>:<nom> d’un plugin absent des plugins de l’utilisateur : intégré', () => {
    expect(sectionSource('ccd:tasks', user)).toEqual({ kind: 'builtin', plugin: 'ccd' })
    expect(sectionSource('hcc:policy', new Set())).toEqual({ kind: 'builtin', plugin: 'hcc' })
  })

  test('un id à plusieurs « : » se coupe au premier', () => {
    expect(sectionSource('hcc:a:b:c', user)).toEqual({ kind: 'plugin', name: 'hcc' })
    expect(sectionSource('ccd:a:hcc:b', user)).toEqual({ kind: 'builtin', plugin: 'ccd' })
    expect(sectionSource('hcc:a:b', new Set(['hcc:a']))).toEqual({ kind: 'builtin', plugin: 'hcc' })
  })

  test('la comparaison au nom du plugin est exacte (casse comprise)', () => {
    expect(sectionSource('HCC:policy', user)).toEqual({ kind: 'builtin', plugin: 'HCC' })
    expect(sectionSource('hcc2:policy', user)).toEqual({ kind: 'builtin', plugin: 'hcc2' })
  })

  test('plugin sans nom de section (« hcc: ») : toujours rattaché au plugin', () => {
    expect(sectionSource('hcc:', user)).toEqual({ kind: 'plugin', name: 'hcc' })
  })

  test('préfixe vide (« :x ») : id mal formé, source inconnue', () => {
    expect(sectionSource(':x', user)).toEqual({ kind: 'unknown' })
  })

  test('id vide : prose du moteur (id nu)', () => {
    expect(sectionSource('', user)).toEqual({ kind: 'engine' })
  })
})

describe('toolProvider', () => {
  test('outil MCP : le serveur est entre « mcp__ » et le « __ » suivant', () => {
    expect(toolProvider('mcp__vercel__list_projects')).toEqual({ kind: 'mcp', server: 'vercel' })
    expect(toolProvider('mcp__claude-in-chrome__navigate')).toEqual({ kind: 'mcp', server: 'claude-in-chrome' })
  })

  test('serveur d’un plugin : tirets et tirets bas simples gardés', () => {
    expect(toolProvider('mcp__plugin_small-business_gmail__get_message')).toEqual({
      kind: 'mcp',
      server: 'plugin_small-business_gmail',
    })
  })

  test('le nom de l’outil peut contenir « __ » : on coupe au premier', () => {
    expect(toolProvider('mcp__srv__a__b')).toEqual({ kind: 'mcp', server: 'srv' })
  })

  test('outil du moteur : sans préfixe MCP', () => {
    expect(toolProvider('Bash')).toEqual({ kind: 'engine' })
    expect(toolProvider('Read')).toEqual({ kind: 'engine' })
    expect(toolProvider('ListMcpResourcesTool')).toEqual({ kind: 'engine' })
    expect(toolProvider('')).toEqual({ kind: 'engine' })
  })

  test('« mcp__ » doit être le préfixe exact', () => {
    expect(toolProvider('xmcp__srv__tool')).toEqual({ kind: 'engine' })
    expect(toolProvider('mcp_srv__tool')).toEqual({ kind: 'engine' })
    expect(toolProvider('MCP__srv__tool')).toEqual({ kind: 'engine' })
  })

  test('nom « mcp__ » sans serveur ou sans outil : pas un outil MCP, moteur', () => {
    expect(toolProvider('mcp__')).toEqual({ kind: 'engine' })
    expect(toolProvider('mcp__srv')).toEqual({ kind: 'engine' })
    expect(toolProvider('mcp__srv__')).toEqual({ kind: 'engine' })
    expect(toolProvider('mcp____tool')).toEqual({ kind: 'engine' })
  })

  test('le résultat du moteur n’a pas de champ server', () => {
    expect(Object.keys(toolProvider('Bash'))).toEqual(['kind'])
  })
})
