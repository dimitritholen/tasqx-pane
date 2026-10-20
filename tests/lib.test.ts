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

  test('fuzzy find ranks exact, prefix, substring, then letters in order', () => {
    const names = ['tasqx-pane', 'tasqx', 'swarmtray', 'swarm', 'qa-overlay']
    expect(lib.fuzzyFind(names, 'tasqx')).toEqual(['tasqx', 'tasqx-pane'])
    expect(lib.fuzzyFind(names, 'swa')).toEqual(['swarm', 'swarmtray'])
    expect(lib.fuzzyFind(names, 'pane')).toEqual(['tasqx-pane'])
    expect(lib.fuzzyFind(names, 'tqp')).toEqual(['tasqx-pane'])
    expect(lib.fuzzyFind(names, 'zzz')).toEqual([])
    expect(lib.fuzzyFind(names, '', 2)).toEqual(['tasqx-pane', 'tasqx'])
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
