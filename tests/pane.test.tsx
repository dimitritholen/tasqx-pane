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
  ['list status:active', { tasks: [task], total: 1 }],
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
      memory: { hits: [] },
    },
  ],
  ['list project:demo @working', { tasks: [task, { ...task, id: 'u-9', short_id: 9, title: 'Next thing', status: 'pending' }], total: 2 }],
  ['list project:demo status:done', { tasks: [{ short_id: 2, title: 'Old work', status: 'done' }] }],
  ['report status project:demo', { groups: [{ status: 'done', count: 1, est_total: 'PT1H', tracked_total: 'PT50M', overdue: 0 }] }],
  ['memory list', { docs: [{ title: 'Always rebase', body_preview: 'Ruling: rebase, never merge.' }] }],
  ['check set', { ok: true }],
]

function fakeWorld(on: On, calls: string[], repoRoot = '/home/me/demo') {
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
    expect(await ui.find({ type: 'Text', text: /#7 Ship the pane/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Checks 1\/2/ })).toBeDefined()
    expect(await ui.find({ key: 'check-c2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#8 pending · Share it/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Dock tasqx beside the transcript/ })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /no tasqx project named "scratch"/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /tasqx init scratch/ })).toBeDefined()
  await ui.unmount()
})
