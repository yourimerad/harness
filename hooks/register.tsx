import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'harness'
const snapshot = atom({ plugin: 'harness', key: 'snapshot' } as const, null)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'harness', description: 'Ouvrir le pane Harnais : tout ce qui entre dans le contexte, et où le couper' })
    return next(e)
  })

  on('command.run', { command: 'harness' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Harnais', focus: true })
    return { text: 'Pane Harnais ouvert.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    return (
      <Box flexDirection="column">
        <Text dimColor>{snap === null ? 'Harnais : capture en attente du premier tour.' : 'Harnais'}</Text>
      </Box>
    )
  })
}
