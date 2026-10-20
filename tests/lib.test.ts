import { describe, expect, test } from 'claude-code/testing'

import * as lib from '../hooks/lib'

describe('durations', () => {
  test('ISO durations parse to seconds', () => {
    expect(lib.parseDuration('PT1H30M')).toBe(5400)
    expect(lib.parseDuration('PT0S')).toBe(0)
    expect(lib.parseDuration('PT227H37M53S')).toBe(227 * 3600 + 37 * 60 + 53)
    expect(lib.parseDuration('P2DT3H')).toBe(2 * 86400 + 3 * 3600)
    expect(lib.parseDuration('PT45.9S')).toBe(45)
    expect(lib.parseDuration(null)).toBe(null)
    expect(lib.parseDuration('soon')).toBe(null)
  })

  test('seconds format for people', () => {
    expect(lib.formatDuration(40)).toBe('40s')
    expect(lib.formatDuration(720)).toBe('12m')
    expect(lib.formatDuration(5400)).toBe('1h 30m')
    expect(lib.formatDuration(3600 * 3)).toBe('3h 00m')
    expect(lib.formatDuration(null)).toBe('—')
  })
})

describe('project mapping', () => {
  const projects = ['tasqx', 'Keel', 'blinqx']

  test('the repository folder names the project, case-insensitively', () => {
    expect(lib.pickProject(projects, 'keel', '')).toEqual({ project: 'Keel', source: 'repo' })
  })

  test('an override that names a live project wins', () => {
    expect(lib.pickProject(projects, 'keel', 'blinqx')).toEqual({ project: 'blinqx', source: 'config' })
  })

  test('an override naming no project falls back to the folder', () => {
    expect(lib.pickProject(projects, 'tasqx', 'gone')).toEqual({ project: 'tasqx', source: 'repo' })
  })

  test('the project picked for the folder wins over the override and the name', () => {
    expect(lib.pickProject(projects, 'tasqx', 'blinqx', 'keel')).toEqual({ project: 'Keel', source: 'folder' })
  })

  test('a picked project that is gone falls back', () => {
    expect(lib.pickProject(projects, 'tasqx', '', 'gone')).toEqual({ project: 'tasqx', source: 'repo' })
  })

  test('a folder with no project shows none, never the default', () => {
    expect(lib.pickProject(projects, 'scratch', '')).toEqual({ project: null, source: 'none' })
  })

  test('basename takes the last segment on any separator', () => {
    expect(lib.basename('/Users/me/projects/tasqx/')).toBe('tasqx')
    expect(lib.basename('C:\\dev\\letmecook')).toBe('letmecook')
  })
})

describe('reading a brief', () => {
  const brief = {
    task: {
      short_id: 7,
      title: 'Ship it',
      project: 'demo',
      priority: 'H',
      urgency: 6,
      estimate: 'PT2H',
      tracked: 'PT30M',
      due: null,
      tags: ['x'],
      first_annotation: { body: 'What and why.\n\nMore detail.', created: '2026-10-19T10:00:00Z' },
      annotations: [
        { body: 'What and why.\n\nMore detail.', created: '2026-10-19T10:00:00Z' },
        { body: 'Direction changed.\n\nBecause.', created: '2026-10-19T11:00:00Z' },
      ],
      annotations_total: 2,
      checks: [{ id: 'c1', body: 'tests pass', state: 'passed' }],
      fresh_tokens: 1200,
      budget_tokens: null,
    },
    neighbourhood: { depends_on: [{ short_id: 3, title: 'Base', status: 'done' }], blocks: [] },
    memory: { hits: [{ title: 'Ruling', source: 'DESIGN.md', snippet: 'one\n  two' }] },
  }

  test('the description is the oldest note, the newest note the last', () => {
    const a = lib.toActiveTask(brief)
    expect(a.description).toBe('What and why.')
    expect(a.latestNote).toEqual({ body: 'Direction changed.', created: '2026-10-19T11:00:00Z' })
    expect(a.trackedSeconds).toBe(1800)
    expect(a.estimateSeconds).toBe(7200)
    expect(a.dependsOn).toEqual([{ shortId: 3, title: 'Base', status: 'done' }])
    expect(a.related[0]?.snippet).toBe('one two')
  })

  test('a task with one note has no separate newest note', () => {
    const one = { ...brief, task: { ...brief.task, annotations: [brief.task.annotations[0]] } }
    expect(lib.toActiveTask(one).latestNote).toBe(null)
  })

  test('the status line names the task, its time and its checks', () => {
    expect(lib.statusText(lib.toActiveTask(brief), 1800)).toBe('▶ #7 30m / 2h 00m · 1/1 checks · Ship it')
  })
})

describe('small rules', () => {
  test('a pressed check cycles open, passed, failed', () => {
    expect(lib.nextCheckState('open')).toBe('passed')
    expect(lib.nextCheckState('passed')).toBe('failed')
    expect(lib.nextCheckState('failed')).toBe('open')
  })

  test('only tasqx tool calls trigger a refresh', () => {
    expect(lib.touchesTasqx('mcp__tasqx__tasqx_set_check', {})).toBe(true)
    expect(lib.touchesTasqx('Bash', { command: 'tasqx done 7' })).toBe(true)
    expect(lib.touchesTasqx('Bash', { command: 'ls tasqxish' })).toBe(false)
    expect(lib.touchesTasqx('Read', { file_path: '/tasqx' })).toBe(false)
  })

  test('the bar fills to its ratio and never past its width', () => {
    expect(lib.bar(0.5, 10)).toBe('[#####-----]')
    expect(lib.bar(3, 4)).toBe('[####]')
  })
})

describe('charts', () => {
  test('the sparkline scales to the largest value and keeps the last ones', () => {
    expect(lib.sparkline([0, 4, 8], 3)).toBe(' ▄█')
    expect(lib.sparkline([1, 2, 3, 4], 2)).toBe('▆█')
    expect(lib.sparkline([1, 100], 2)).toBe('▁█')
  })

  test('base64 matches the standard alphabet and padding', () => {
    const enc = (t: string) => lib.base64(new TextEncoder().encode(t))
    expect(enc('Man')).toBe('TWFu')
    expect(enc('Ma')).toBe('TWE=')
    expect(enc('M')).toBe('TQ==')
  })

  test('raster cells stack eighth blocks bottom-up, the last column in its own color', () => {
    const { cells, columns } = lib.barCells([4, 16], 10, 2, 0x111111, 0x222222)
    expect(columns).toBe(2)
    // decode: 2 columns x 2 rows x [codePoint, fg, bg]
    const bin = Uint8Array.from(atob(cells), c => c.charCodeAt(0))
    const words = new Uint32Array(bin.buffer)
    const at = (row: number, col: number) => words.slice((row * 2 + col) * 3, (row * 2 + col) * 3 + 3)
    expect(String.fromCodePoint(at(0, 0)[0]!)).toBe(' ')
    expect(String.fromCodePoint(at(1, 0)[0]!)).toBe('▄')
    expect(String.fromCodePoint(at(0, 1)[0]!)).toBe('█')
    expect(at(0, 1)[1]).toBe(0x222222)
    expect(at(1, 0)[2]).toBe(lib.DEFAULT_COLOR)
  })

  test('the meter fills to its ratio', () => {
    expect(lib.meter(0.25, 8)).toEqual({ filled: '██', empty: '░░░░░░' })
  })
})

test('the handoff prompt fills in id, title and project', () => {
  expect(lib.handoffText('#{id} {title} in {project}, #{id}', { shortId: 9, title: 'Next', project: 'demo' })).toBe(
    '#9 Next in demo, #9',
  )
})

test('tags are collected once each, sorted', () => {
  expect(lib.collectTags([{ tags: ['b', 'a'] }, { tags: ['a'] }, {}])).toEqual(['a', 'b'])
})

test('the tag handoff names the filter and the ready tasks', () => {
  expect(lib.tagHandoffText('project:demo @working +mod', [9, 12])).toBe(
    'Work through the tasqx tasks in `project:demo @working +mod`, most urgent first (now #9, #12). Read each brief first and finish one before you start the next.',
  )
})

describe('enforcing rulings', () => {
  test('the task id comes from the first of the three prompt forms', () => {
    expect(lib.taskIdIn('Run `tasqx show 2342 --card` first')).toBe(2342)
    expect(lib.taskIdIn('work on branch task/77-fix-it from main')).toBe(77)
    expect(lib.taskIdIn('You are the builder for tasqx task #9 in the repo')).toBe(9)
    expect(lib.taskIdIn('tasqx task #5, then tasqx show 6')).toBe(5)
    expect(lib.taskIdIn('fix issue #12 and see task 40')).toBe(null)
    expect(lib.taskIdIn('task/abc-1 and tasqx shows 3 and mytasqx show 4')).toBe(null)
    expect(lib.taskIdIn('')).toBe(null)
  })

  test('only rulings of this project or none, changed after the start, make the section', () => {
    const start = Date.parse('2026-10-20T10:00:00Z')
    const doc = (title: string, project: string | null, modified: string, body = `Ruling: ${title}.\nwhy`) => ({
      title,
      project,
      standing: true,
      created: '2026-10-01T00:00:00Z',
      modified,
      body_preview: body,
    })
    const docs = [
      doc('old', 'demo', '2026-10-20T09:59:00Z'),
      doc('mine', 'Demo', '2026-10-20T10:05:00Z'),
      doc('global', null, '2026-10-20T10:06:00Z', '\n  Ruling: everywhere.  \nmore'),
      doc('theirs', 'other', '2026-10-20T10:07:00Z'),
    ]
    expect(lib.liveRulingsText(docs, 'demo', start)).toBe(
      'Standing rulings added during this session — follow them:\n- mine: Ruling: mine.\n- global: Ruling: everywhere.',
    )
    expect(lib.liveRulingsText(docs, null, start)).toBe(
      'Standing rulings added during this session — follow them:\n- global: Ruling: everywhere.',
    )
    expect(lib.liveRulingsText(docs, 'demo', Date.parse('2026-10-21T00:00:00Z'))).toBe(null)
  })
})
