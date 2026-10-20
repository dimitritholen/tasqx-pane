import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-19T12:00:00Z')

const task = {
  id: 'u-7',
  _rev: 3,
  short_id: 7,
  title: 'Ship the pane',
  status: 'active',
  project: 'demo',
  priority: 'H',
  urgency: 6,
  estimate: 'PT2H',
  tracked: 'PT30M',
  tags: ['mod'],
}

// What each tasqx call answers, by the arguments it starts with.
const ANSWERS: Array<[string, unknown]> = [
  ['projects', { projects: [{ name: 'demo', archived: false }, { name: 'other', archived: false }] }],
  ['list project:demo status:active', { tasks: [task], total: 1 }],
  [
    'brief 7',
    {
      task: {
        ...task,
        first_annotation: { body: 'Dock tasqx beside the transcript.', created: '2026-10-19T09:00:00Z' },
        annotations: [{ body: 'Dock tasqx beside the transcript.', created: '2026-10-19T09:00:00Z' }],
        annotations_total: 1,
        checks: [
          { id: 'c1', body: 'validate passes', state: 'passed' },
          { id: 'c2', body: 'tests pass', state: 'open' },
        ],
        fresh_tokens: 0,
        budget_tokens: null,
      },
      neighbourhood: { depends_on: [], blocks: [{ short_id: 8, title: 'Share it', status: 'pending' }] },
      memory: { hits: [{ title: 'Mods run unsandboxed', source: 'DESIGN.md', snippet: 'A mod runs with your permissions.' }] },
    },
  ],
  ['list project:demo @working', { tasks: [task, { ...task, id: 'u-9', short_id: 9, title: 'Next thing', status: 'pending' }], total: 2 }],
  ['list project:demo status:done', { tasks: [{ short_id: 2, title: 'Old work', status: 'done' }] }],
  ['report status project:demo', { groups: [{ status: 'done', count: 1, est_total: 'PT1H', tracked_total: 'PT50M', overdue: 0 }] }],
  ['memory list', { docs: [{ title: 'Always rebase', body_preview: 'Ruling: rebase, never merge.' }] }],
  ['chart burndown project:demo', { series: [{ date: '2026-10-17', remaining: 4 }, { date: '2026-10-18', remaining: 3 }, { date: '2026-10-19', remaining: 2 }] }],
  ['check set', { ok: true }],
  ['start', { status: 'active' }],
  ['stop', { status: 'pending' }],
]

function fakeWorld(on: On, calls: string[], repoRoot = '/home/me/demo', filled: string[] = [], store: Record<string, unknown> = {}) {
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('process.run', ($, e) => {
    const args = e.argv.slice(1).filter(a => a !== '--json').join(' ')
    calls.push(args)
    const hit = ANSWERS.find(([prefix]) => args.startsWith(prefix))
    return {
      value: {
        exitCode: hit ? 0 : 2,
        stdout: hit ? JSON.stringify(hit[1]) : '',
        stderr: hit ? '' : `no fake for: ${args}`,
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.repo', () => ({ value: { root: repoRoot, remote: null, internal: false, name: null } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
}

// What the person typing `/tasqx-pane <args>` in a wide fullscreen terminal sends.
const typed = (args: string) => ({
  command: 'tasqx-pane',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 200 },
})

const PANE_PROPS = {
  title: 'tasqx · demo',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

test('the pane shows the active task, its checks and what it unblocks', async ($, on) => {
  const calls: string[] = []
  fakeWorld(on, calls)
  mock.clock(on, { now: NOW })

  await $.command.run(typed(''))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'tasqx-pane', surface, component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /^#7$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Ship the pane$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1\/2$/ })).toBeDefined()
    expect(await ui.find({ key: 'check-c2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /unblocks #8.*Share it/ })).toBeDefined()
    expect(await ui.find({ key: 'desc-md' })).toBeDefined()
    await ui.unmount()
  }
})

test('pressing an open check marks it passed by its position', async ($, on) => {
  const calls: string[] = []
  fakeWorld(on, calls)
  mock.clock(on, { now: NOW })
  await $.command.run(typed(''))

  const ui = await $.ui.mount({ plugin: 'tasqx-pane', surface: 'terminal', component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
  await ui.press({ key: 'check-c2' })
  expect(calls).toContain('check set 7 2 passed')
  await ui.unmount()
})

test('the queue tab lists the working set without the active task', async ($, on) => {
  fakeWorld(on, [])
  mock.clock(on, { now: NOW })
  await $.command.run(typed('queue'))

  const ui = await $.ui.mount({ plugin: 'tasqx-pane', surface: 'terminal', component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
  expect(await ui.find({ key: 'start-9' })).toBeDefined()
  expect(await ui.find({ key: 'start-7' })).toBeUndefined()
  await ui.unmount()
})

test('a folder with no project says so instead of showing another project', async ($, on) => {
  fakeWorld(on, [], '/home/me/scratch')
  mock.clock(on, { now: NOW })
  await $.command.run(typed('queue'))

  const ui = await $.ui.mount({ plugin: 'tasqx-pane', surface: 'terminal', component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
  expect((await ui.find({ key: 'project-pick' }))?.props.label).toBe('no project "scratch"')
  expect(await ui.find({ type: 'Text', text: /tasqx init scratch/ })).toBeDefined()
  await ui.unmount()
})

test('picking a project in a folder without one shows it and remembers it', async ($, on) => {
  const store: Record<string, unknown> = {}
  fakeWorld(on, [], '/home/me/scratch', [], store)
  mock.clock(on, { now: NOW })
  await $.command.run(typed('queue'))

  const ui = await $.ui.mount({ plugin: 'tasqx-pane', surface: 'terminal', component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
  await ui.select({ key: 'project-pick', value: 'demo' })
  expect(store).toEqual({ 'folder:/home/me/scratch': 'demo' })
  expect(await ui.find({ type: 'Text', text: /Next thing/ })).toBeDefined()
  await ui.unmount()
})

test('a folder opens on the project it remembers', async ($, on) => {
  fakeWorld(on, [], '/home/me/scratch', [], { 'folder:/home/me/scratch': 'demo' })
  mock.clock(on, { now: NOW })
  await $.command.run(typed('queue'))

  const ui = await $.ui.mount({ plugin: 'tasqx-pane', surface: 'terminal', component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /Next thing/ })).toBeDefined()
  await ui.unmount()
})

test("a folder with no project shows no other project's active task", async ($, on) => {
  const calls: string[] = []
  fakeWorld(on, calls, '/home/me/scratch')
  mock.clock(on, { now: NOW })
  await $.command.run(typed(''))

  const ui = await $.ui.mount({ plugin: 'tasqx-pane', surface: 'terminal', component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /Ship the pane/ })).toBeUndefined()
  expect(calls.some(c => c.includes('status:active'))).toBe(false)
  await ui.unmount()
})

test('the project tab draws the burndown as a Raster on the terminal and as text elsewhere', async ($, on) => {
  fakeWorld(on, [])
  mock.clock(on, { now: NOW })
  await $.command.run(typed('project'))

  const term = await $.ui.mount({ plugin: 'tasqx-pane', surface: 'terminal', component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
  expect((await term.find({ key: 'burndown' }))?.type).toBe('Raster')
  expect(await term.find({ type: 'Text', text: /^2 open now$/ })).toBeDefined()
  await term.unmount()

  const desk = await $.ui.mount({ plugin: 'tasqx-pane', surface: 'desktop', component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
  expect(await desk.find({ type: 'Text', text: /^█▆▄$/ })).toBeDefined()
  await desk.unmount()
})

test('the memory tab draws the rulings and the hits for the active task', async ($, on) => {
  fakeWorld(on, [])
  mock.clock(on, { now: NOW })
  await $.command.run(typed('memory'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'tasqx-pane', surface, component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /Always rebase/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Mods run unsandboxed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^A mod runs with your permissions\.$/ })).toBeDefined()
    await ui.unmount()
  }
})

const noteTexts = (session: { appended: () => readonly { message: unknown }[] }) =>
  session.appended().map(row => JSON.stringify(row.message))

test('Hand to Claude on a queued task starts it and fills the prompt, unsent', async ($, on) => {
  const calls: string[] = []
  const filled: string[] = []
  fakeWorld(on, calls, '/home/me/demo', filled)
  mock.clock(on, { now: NOW })
  await $.command.run(typed('queue'))

  const ui = await $.ui.mount({ plugin: 'tasqx-pane', surface: 'terminal', component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
  await ui.press({ key: 'handoff-9' })
  expect(calls).toContain('start 9')
  expect(filled).toEqual(['Work on tasqx task #9: Next thing. Read its brief first.'])
  await ui.unmount()
})

test('picking a tag filters the queue, and its batch button fills the prompt without starting a timer', async ($, on) => {
  const calls: string[] = []
  const filled: string[] = []
  fakeWorld(on, calls, '/home/me/demo', filled)
  mock.clock(on, { now: NOW })
  await $.command.run(typed('queue'))

  const ui = await $.ui.mount({ plugin: 'tasqx-pane', surface: 'terminal', component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
  expect(await ui.find({ key: 'handoff-tag' })).toBeUndefined()
  await ui.select({ key: 'tag-pick', value: 'mod' })
  expect(calls).toContain('list project:demo @working +mod --limit 15')
  await ui.press({ key: 'handoff-tag' })
  expect(filled).toEqual([
    'Work through the tasqx tasks in `project:demo @working +mod`, most urgent first (now #9). Read each brief first and finish one before you start the next.',
  ])
  expect(calls.some(c => c.startsWith('start'))).toBe(false)
  await ui.unmount()
})

test('Hand to Claude on the active task fills the prompt without starting it again', async ($, on) => {
  const calls: string[] = []
  const filled: string[] = []
  fakeWorld(on, calls, '/home/me/demo', filled)
  mock.clock(on, { now: NOW })
  await $.command.run(typed('task'))

  const ui = await $.ui.mount({ plugin: 'tasqx-pane', surface: 'terminal', component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
  await ui.press({ key: 'handoff-7' })
  expect(calls.filter(c => c.startsWith('start'))).toEqual([])
  expect(filled).toHaveLength(1)
  await ui.unmount()
})

test('Start tells Claude in a note that starts no turn', async ($, on) => {
  fakeWorld(on, [])
  const session = mock.session(on)
  mock.clock(on, { now: NOW })
  await $.command.run(typed('queue'))

  const ui = await $.ui.mount({ plugin: 'tasqx-pane', surface: 'terminal', component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
  await ui.press({ key: 'start-9' })
  const notes = noteTexts(session)
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('started the tasqx timer on #9')
  await ui.unmount()
})

test('with Tell Claude off, Start adds no note', { options: { tellClaude: 'off' } }, async ($, on) => {
  fakeWorld(on, [])
  const session = mock.session(on)
  mock.clock(on, { now: NOW })
  await $.command.run(typed('queue'))

  const ui = await $.ui.mount({ plugin: 'tasqx-pane', surface: 'terminal', component: 'Pane', requestId: 'tasqx', props: PANE_PROPS })
  await ui.press({ key: 'start-9' })
  expect(noteTexts(session)).toEqual([])
  await ui.unmount()
})
