import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const START = Date.parse('2026-10-20T10:00:00Z')

type World = { calls: string[]; toasts: string[]; spawned: string[]; status: string; docs: unknown[] }

function fakeWorld(on: On, w: World) {
  on('process.run', ($, e) => {
    const args = e.argv.slice(1).filter(a => a !== '--json').join(' ')
    w.calls.push(args)
    let out: unknown = null
    if (args === 'projects') out = { projects: [{ name: 'demo', archived: false }] }
    else if (args === 'start 12 --keep' && w.status !== 'done')
      out = { short_id: 12, title: 'Build it', status: 'active', already_running: w.status === 'active' }
    else if (args === 'memory list --standing') out = { docs: w.docs }
    else if (args.startsWith('list ')) out = { tasks: [], total: 0 }
    return {
      value: {
        exitCode: out ? 0 : 5,
        stdout: out ? JSON.stringify(out) : JSON.stringify({ ok: false, error: { code: 'conflict', message: 'cannot start a done task' } }),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('agent.spawn', ($, e) => {
    w.spawned.push(e.prompt)
    return { model: 'test-model', agentId: 'agent-1' }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: '/home/me/demo', remote: null, internal: false, name: null } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  mock.store(on)
}

// What the Agent tool hands agent.spawn for a builder launched with `prompt`.
const spawn = (prompt: string) => ({
  tool_use_id: 'toolu_1',
  prompt,
  description: 'build it',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'm',
  background: false,
  fork: false,
})

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal' as const], tools: [], outputStyle: null, traits: [] }

const world = (status = 'pending'): World => ({ calls: [], toasts: [], spawned: [], status, docs: [] })
const PROMPT = 'You are the builder for tasqx task #12. Run `tasqx show 12 --card` first.'

test('a builder spawned on a pending task starts its timer and says so', async ($, on) => {
  const w = world('pending')
  fakeWorld(on, w)
  mock.clock(on, { now: START })
  const spawned = await $.agent.spawn(spawn(PROMPT))
  expect(spawned.agentId).toBe('agent-1')
  expect(w.spawned).toEqual([PROMPT])
  expect(w.calls).toEqual(['start 12 --keep'])
  expect(w.toasts.some(t => t.includes('timer started on #12') && t.includes('Build it'))).toBe(true)
})

test('a builder spawned on an active task leaves its timer alone', async ($, on) => {
  const w = world('active')
  fakeWorld(on, w)
  mock.clock(on, { now: START })
  await $.agent.spawn(spawn(PROMPT))
  expect(w.spawned).toEqual([PROMPT])
  expect(w.calls).toEqual(['start 12 --keep'])
  expect(w.toasts).toEqual([])
})

test('a refused start (a done task) toasts the reason and still spawns the builder unchanged', async ($, on) => {
  const w = world('done')
  fakeWorld(on, w)
  mock.clock(on, { now: START })
  const spawned = await $.agent.spawn(spawn(PROMPT))
  expect(spawned.agentId).toBe('agent-1')
  expect(w.spawned).toEqual([PROMPT])
  expect(w.calls).toEqual(['start 12 --keep'])
  expect(w.toasts.some(t => t.includes('could not start #12') && t.includes('cannot start a done task'))).toBe(true)
})

test('a spawn naming no task runs no tasqx at all', async ($, on) => {
  const w = world('pending')
  fakeWorld(on, w)
  mock.clock(on, { now: START })
  await $.agent.spawn(spawn('Find every caller of foo.'))
  expect(w.spawned).toEqual(['Find every caller of foo.'])
  expect(w.calls).toEqual([])
})

test('with autoStartOnSpawn off, a builder starts no timer', { options: { autoStartOnSpawn: 'off' } }, async ($, on) => {
  const w = world('pending')
  fakeWorld(on, w)
  mock.clock(on, { now: START })
  await $.agent.spawn(spawn(PROMPT))
  expect(w.spawned).toEqual([PROMPT])
  expect(w.calls).toEqual([])
})

const ruling = (title: string, project: string | null, modified: string) => ({
  title,
  project,
  standing: true,
  created: modified,
  modified,
  body_preview: `Ruling: ${title}.\nbecause`,
})

test('compose adds only the rulings recorded since the session started', async ($, on) => {
  const w = world()
  fakeWorld(on, w)
  const clock = mock.clock(on, { now: START })
  await $.session.start({ cwd: '/home/me/demo', surface: 'terminal', isInteractive: true })

  w.docs = [ruling('before', 'demo', '2026-10-20T09:00:00Z')]
  const quiet = await $.prompt.compose(COMPOSE)
  expect(quiet.sections.map(s => s.id)).toEqual(['intro'])

  // the listing is reused for 30 s, then read again
  w.docs = [...w.docs, ruling('fresh', 'demo', '2026-10-20T10:01:00Z'), ruling('global', null, '2026-10-20T10:01:00Z'), ruling('elsewhere', 'other', '2026-10-20T10:01:00Z')]
  expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toEqual(['intro'])
  await clock.advance(31_000)
  const composed = await $.prompt.compose(COMPOSE)
  const added = composed.sections.find(s => s.id === 'tasqx-pane:live-rulings')
  expect(added?.scope).toBe('session')
  expect(added?.text).toBe(
    'Standing rulings added during this session — follow them:\n- fresh: Ruling: fresh.\n- global: Ruling: global.',
  )
  expect(w.calls.filter(c => c === 'memory list --standing').length).toBe(2)
})

test('with liveRulings off, compose adds nothing and lists nothing', { options: { liveRulings: 'off' } }, async ($, on) => {
  const w = world()
  fakeWorld(on, w)
  mock.clock(on, { now: START })
  await $.session.start({ cwd: '/home/me/demo', surface: 'terminal', isInteractive: true })
  w.docs = [ruling('fresh', 'demo', '2026-10-20T10:01:00Z')]
  expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toEqual(['intro'])
  expect(w.calls).not.toContain('memory list --standing')
})
