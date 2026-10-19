import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, RenderChildren } from 'claude-code'

import type { ActiveTask, Snapshot, StatusCount, Tab } from '../types'
import * as lib from './lib'

type Engine = EngineInterface

const PANE = 'tasqx'
const BURNDOWN_DAYS = 60
const TABS: readonly Tab[] = ['task', 'queue', 'project', 'memory']
const TAB_LABEL: Record<Tab, string> = { task: 'Task', queue: 'Queue', project: 'Project', memory: 'Memory' }

const snapshot = atom({ plugin: 'tasqx-pane', key: 'snapshot' } as const, null)
const tab = atom({ plugin: 'tasqx-pane', key: 'tab' } as const, 'task')
const busy = atom({ plugin: 'tasqx-pane', key: 'busy' } as const, null)

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const projectFilter = (p: string) => `project:${/\s/.test(p) ? `"${p}"` : p}`

// Set from the plugin's options when the module registers.
const cfg = {
  bin: 'tasqx',
  override: '',
  autoOpen: true,
  showStatus: true,
  periodMs: 15_000,
  tellClaude: true,
  handoff: 'Work on tasqx task #{id}: {title}. Read its brief first.',
}

// What the module remembers between refreshes; a reload starts it over.
const cache = {
  projects: null as string[] | null,
  briefKey: '',
  briefAt: 0,
  brief: null as ActiveTask | null,
  running: null as Promise<void> | null,
  again: false,
  full: false,
}

/** One `tasqx <args> --json` call; rejects with tasqx's own error message. */
async function tasqx($: Engine, args: string[]): Promise<any> {
  let ran
  try {
    ran = await $.process.run([cfg.bin, ...args, '--json'], { timeoutMs: 15000 })
  } catch (err) {
    throw new Error(`could not run ${cfg.bin}: ${message(err)}`)
  }
  const out = ran.stdout.trim()
  let parsed: any = null
  try {
    parsed = out ? JSON.parse(out) : null
  } catch {
    // not JSON: fall through to the exit code
  }
  if (parsed?.ok === false) throw new Error(parsed.error?.message ?? 'tasqx refused the call')
  if (ran.exitCode !== 0 || parsed === null) {
    throw new Error((ran.stderr || out).trim().split('\n')[0] || `${cfg.bin} exited ${ran.exitCode}`)
  }
  return parsed
}

async function resolveProject($: Engine) {
  if (!cache.projects) {
    const listed = await tasqx($, ['projects'])
    cache.projects = (listed.projects ?? []).filter((p: any) => !p.archived).map((p: any) => String(p.name))
  }
  const repo = await $.session.repo()
  const dirName = lib.basename(repo?.root ?? (await $.session.root()))
  return { ...lib.pickProject(cache.projects ?? [], dirName, cfg.override), dirName }
}

async function load($: Engine, isFull: boolean): Promise<Snapshot> {
  const fetchedAt = await $.clock.now()
  const base: Snapshot = {
    project: null,
    projectSource: 'none',
    dirName: null,
    active: null,
    otherActive: [],
    queue: [],
    queueTotal: 0,
    recentDone: [],
    stats: [],
    rulings: [],
    burndown: { from: null, remaining: [] },
    fetchedAt,
    isFull,
    error: null,
  }
  try {
    const { project, source, dirName } = await resolveProject($)
    Object.assign(base, { project, projectSource: source, dirName })

    const actives: any[] = (await tasqx($, ['list', 'status:active', '--sort', '-modified'])).tasks ?? []
    const [first, ...rest] = actives
    base.otherActive = rest.map(lib.toTaskRef)
    if (first) {
      // brief runs a memory search (~0.5 s): read it again on a change, else each minute
      const key = `${first.id}:${first._rev}`
      if (!cache.brief || key !== cache.briefKey || fetchedAt - cache.briefAt > 60_000) {
        cache.brief = lib.toActiveTask(await tasqx($, ['brief', String(first.short_id), '--memory-limit', '3']))
        cache.briefKey = key
        cache.briefAt = fetchedAt
      }
      base.active = { ...cache.brief, trackedSeconds: lib.parseDuration(first.tracked) ?? cache.brief.trackedSeconds }
    } else {
      cache.brief = null
    }

    if (isFull && project) {
      const scope = projectFilter(project)
      const [queue, done, report, rulings, burndown] = await Promise.all([
        tasqx($, ['list', scope, '@working', '--limit', '15']),
        tasqx($, ['list', scope, 'status:done', '--sort', '-modified', '--limit', '5']),
        tasqx($, ['report', 'status', scope]),
        tasqx($, ['memory', 'list', '--project', project, '--standing', '--limit', '10']),
        tasqx($, ['chart', 'burndown', scope, '--days', String(BURNDOWN_DAYS)]),
      ])
      const series: any[] = burndown.series ?? []
      base.burndown = { from: series[0]?.date ?? null, remaining: series.map(d => Number(d.remaining) || 0) }
      base.queue = (queue.tasks ?? []).filter((t: any) => t.status !== 'active').map(lib.toQueueRow)
      base.queueTotal = queue.total ?? base.queue.length
      base.recentDone = (done.tasks ?? []).map(lib.toTaskRef)
      base.stats = lib.toStats(report)
      base.rulings = (rulings.docs ?? []).map((d: any) => ({
        title: String(d.title ?? ''),
        preview: String(d.body_preview ?? ''),
      }))
    }
  } catch (err) {
    base.error = message(err)
  }
  return base
}

async function isPaneOpen($: Engine) {
  return (await $.ui.panes()).some(p => p.id === PANE)
}

/**
 * Reads tasqx again: everything while the pane is open (or `full`), else the
 * active task alone. Calls made while one runs fold into one more pass.
 */
function refresh($: Engine, force = false, full = false): Promise<void> {
  if (force) cache.briefKey = ''
  if (full) cache.full = true
  if (cache.running) {
    cache.again = true
    return cache.running
  }
  cache.running = (async () => {
    do {
      cache.again = false
      const isFull = cache.full || (await isPaneOpen($))
      cache.full = false
      const snap = await load($, isFull)
      await update($, snapshot, () => snap)
      if (cfg.showStatus) {
        $.ui.status(snap.active ? lib.statusText(snap.active, snap.active.trackedSeconds) : undefined)
      }
    } while (cache.again)
  })().finally(() => {
    cache.running = null
  })
  return cache.running
}

/**
 * Tells Claude what the person did in the pane: a row the model reads on its
 * next turn, which starts no turn and which the transcript does not show.
 */
async function tell($: Engine, text: string) {
  if (!cfg.tellClaude) return
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[tasqx-pane] ${text}` }] } })
  } catch {
    // a session that takes no rows (a -p run with hooks off) just is not told
  }
}

/** Runs one tasqx write; on success tells Claude `note` (when given). */
async function act($: Engine, args: string[], label: string, note?: string): Promise<boolean> {
  await update($, busy, () => label)
  try {
    await tasqx($, args)
    $.ui.toast(`tasqx: ${label}`)
    if (note) await tell($, note)
    return true
  } catch (err) {
    $.ui.toast(`tasqx: ${label} failed: ${message(err)}`)
    return false
  } finally {
    await update($, busy, () => null)
    await refresh($, true)
  }
}

/**
 * Hands a task to Claude: starts its timer (unless it runs already), then puts
 * the handoff prompt in the prompt box, unsent, for the person to send.
 */
async function handoff($: Engine, task: { shortId: number; title: string; project: string | null }, isActive: boolean) {
  if (!isActive && !(await act($, ['start', String(task.shortId)], `started #${task.shortId}`))) return
  const filled = await $.prompt.fill({ text: lib.handoffText(cfg.handoff, task) })
  $.ui.toast(
    filled.isFilled
      ? `#${task.shortId} is in the prompt: Esc back to it, then Enter to send.`
      : `tasqx: could not fill the prompt (${filled.refusal ?? 'no prompt box'}).`,
  )
}

const quote = (title: string) => `"${title.length > 80 ? `${title.slice(0, 77)}…` : title}"`

/** Opens (or retitles) the pane, then reads everything for it. */
async function openPane($: Engine) {
  let title = 'tasqx'
  try {
    const { project } = await resolveProject($)
    if (project) title = `tasqx · ${project}`
  } catch {
    // the refresh records the error in the snapshot
  }
  const opened = await $.ui.open({ id: PANE, title })
  await refresh($, true, true)
  return opened
}

export const register: Register = (on, options) => {
  cfg.bin = String(options.tasqxPath || 'tasqx')
  cfg.override = String(options.project ?? '')
  cfg.autoOpen = options.autoOpen !== 'off'
  cfg.showStatus = options.statusLine !== 'off'
  cfg.periodMs = Math.max(5, Number(options.refreshSeconds) || 15) * 1000
  cfg.tellClaude = options.tellClaude !== 'off'
  cfg.handoff = String(options.handoffPrompt || cfg.handoff)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tasqx-pane',
      description: 'Open the tasqx pane: active task, queue, project numbers, standing rulings',
      argumentHint: '[task|queue|project|memory|refresh|close]',
    })
    const started = await next(e)
    $.clock.every(cfg.periodMs, () => void refresh($))
    $.clock.after(10, async () => {
      let project: string | null = null
      try {
        project = (await resolveProject($)).project
      } catch {
        // the refresh records the error in the snapshot
      }
      if (cfg.autoOpen && project) await openPane($)
      else await refresh($)
    })
    return started
  })

  on('command.run', { command: 'tasqx-pane' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Closed the tasqx pane.' }
    }
    if ((TABS as readonly string[]).includes(arg)) await update($, tab, () => arg as Tab)
    cache.projects = null
    const opened = await openPane($)
    const snap = await read($, snapshot)
    if (snap?.error) return { text: `tasqx pane: ${snap.error}` }
    if (!opened.isPlaced) {
      const active = snap?.active ? lib.statusText(snap.active, snap.active.trackedSeconds) : 'no active task'
      return { text: `tasqx pane is open but not drawn here (${opened.reason}). ${active}` }
    }
    return { text: `Opened the tasqx pane${snap?.project ? ` for ${snap.project}` : ''}.` }
  })

  // Refresh right after anything that may have written to the store.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (lib.touchesTasqx(String(e.tool), e)) $.clock.after(150, () => void refresh($, true))
    return result
  }).catch(($, e, next) => next(e))


  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : null
    const snap = await read($, snapshot)
    const current = await read($, tab)
    const working = await read($, busy)
    const now = await $.clock.now()
    const width = Math.max(24, e.props.bodyColumns)
    // a card's border and padding take four columns
    const inner = width - 4
    // a snapshot read while the pane was closed lacks the queue: read it whole
    if (snap && !snap.isFull) $.clock.after(0, () => void refresh($, false, true))

    const card = (key: string, title: string, body: RenderChildren, opts: { color?: Color; titleColor?: Color; right?: string } = {}) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={opts.color ?? 'inactive'} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text bold color={opts.titleColor} wrap="truncate-end">
            {title}
          </Text>
          {opts.right ? <Text dimColor>{opts.right}</Text> : null}
        </Box>
        {body}
      </Box>
    )
    const chip = (text: string, color: Color) => (
      <Text inverse bold color={color}>
        {` ${text} `}
      </Text>
    )
    const meter = (ratio: number, cells: number, color: Color) => {
      const m = lib.meter(ratio, cells)
      return (
        <Text>
          <Text color={color}>{m.filled}</Text>
          <Text dimColor>{m.empty}</Text>
        </Text>
      )
    }
    const dim = (text: string) => <Text dimColor>{text}</Text>

    const tabs = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {TABS.map(t => (
          <Button
            key={`tab-${t}`}
            label={TAB_LABEL[t]}
            hotkey={t[0]}
            variant={t === current ? 'primary' : undefined}
            onPress={() => update($, tab, () => t)}
          />
        ))}
        <Button key="refresh" label="↻" hotkey="r" onPress={() => refresh($, true)} />
      </Box>
    )

    if (!snap) {
      return (
        <Box flexDirection="column">
          {tabs}
          {dim('Reading tasqx…')}
        </Box>
      )
    }

    const updated = new Date(snap.fetchedAt).toTimeString().slice(0, 5)
    const header = (
      <Box flexDirection="column">
        {tabs}
        <Box flexDirection="row" justifyContent="space-between" gap={1} paddingX={1}>
          <Text bold wrap="truncate-end">
            {snap.project ?? `no project "${snap.dirName ?? '?'}"`}
            {snap.projectSource === 'config' ? <Text dimColor> (from /config)</Text> : null}
          </Text>
          <Text dimColor>{working ? `${working}…` : `updated ${updated}`}</Text>
        </Box>
      </Box>
    )

    if (snap.error) {
      return (
        <Box flexDirection="column">
          {header}
          {card(
            'error',
            'tasqx did not answer',
            <Box flexDirection="column">
              <Text color="error" wrap="wrap">
                {snap.error}
              </Text>
              {dim(`Is tasqx installed? Set its path under /config → tasqx-pane → tasqx binary (now "${cfg.bin}").`)}
            </Box>,
            { color: 'error' },
          )}
        </Box>
      )
    }

    const noProject =
      snap.project === null
        ? card(
            'no-project',
            'No project for this folder',
            dim(
              `Create one with tasqx init ${snap.dirName ?? '<name>'}, or pick one under /config → tasqx-pane → Project override.`,
            ),
            { color: 'warning' },
          )
        : null

    const startButton = (t: { shortId: number; title: string }, hotkey?: string) => (
      <Button
        key={`start-${t.shortId}`}
        label="Start"
        hotkey={hotkey}
        onPress={() =>
          act(
            $,
            ['start', String(t.shortId)],
            `started #${t.shortId}`,
            `The user started the tasqx timer on #${t.shortId} ${quote(t.title)} from the pane, so it is their task in progress. Nothing is asked of you.`,
          )
        }
      />
    )
    const handoffButton = (t: { shortId: number; title: string }, isActive: boolean, hotkey?: string) => (
      <Button
        key={`handoff-${t.shortId}`}
        label={hotkey ? 'Hand to Claude' : '→ Claude'}
        hotkey={hotkey}
        onPress={() => handoff($, { ...t, project: snap.project }, isActive)}
      />
    )

    const statusIcon = (status: string) =>
      status === 'done' ? <Text color="success">✔</Text> : status === 'active' ? <Text color="suggestion">▶</Text> : <Text color="warning">●</Text>

    const taskTab = () => {
      const a = snap.active
      if (!a) {
        const top = snap.queue.find(t => !t.blocked)
        return (
          <Box flexDirection="column">
            {card(
              'idle',
              'No active task',
              top ? (
                <Box flexDirection="column">
                  {dim('Next up')}
                  <Text bold wrap="wrap">
                    #{top.shortId} {top.title}
                  </Text>
                  <Text>
                    {chip(top.priority ?? '-', lib.priorityColor(top.priority))}
                    <Text dimColor>
                      {'  '}urgency {top.urgency.toFixed(1)} · est {lib.formatDuration(top.estimateSeconds)}
                    </Text>
                  </Text>
                  <Box marginTop={1} gap={1}>
                    {startButton(top, 's')}
                    {handoffButton(top, false, 'c')}
                  </Box>
                </Box>
              ) : (
                dim('Nothing waiting in the working set.')
              ),
            )}
            {noProject}
          </Box>
        )
      }

      const elapsed = a.trackedSeconds + Math.max(0, (now - snap.fetchedAt) / 1000)
      const ratio = a.estimateSeconds ? elapsed / a.estimateSeconds : 0
      const isOver = a.estimateSeconds !== null && ratio > 1
      const passed = a.checks.filter(c => c.state === 'passed').length
      const isOverdue = a.due !== null && Date.parse(a.due) < now
      const timeText = a.estimateSeconds
        ? ` ${lib.formatDuration(elapsed)} / ${lib.formatDuration(a.estimateSeconds)} · ${Math.round(ratio * 100)}%`
        : ` ${lib.formatDuration(elapsed)} tracked`

      return (
        <Box flexDirection="column">
          {card(
            'task',
            `#${a.shortId}`,
            <Box flexDirection="column">
              <Text bold wrap="wrap">
                {a.title}
              </Text>
              <Text wrap="truncate-end">
                {chip(a.priority ?? '-', lib.priorityColor(a.priority))}
                <Text dimColor>
                  {'  '}
                  {a.project} · urgency {a.urgency.toFixed(1)}
                </Text>
                {a.tags.map(t => (
                  <Text key={`tag-${t}`} color="suggestion">{`  +${t}`}</Text>
                ))}
              </Text>
              <Text>
                {a.estimateSeconds ? meter(Math.min(1, ratio), Math.max(8, inner - timeText.length), isOver ? 'warning' : 'suggestion') : null}
                <Text color={isOver ? 'warning' : undefined}>{timeText}</Text>
              </Text>
              {a.due ? (
                <Text color={isOverdue ? 'error' : undefined}>
                  Due {a.due.slice(0, 10)} · {lib.relativeTime(a.due, now)}
                </Text>
              ) : null}
              {a.freshTokens > 0 || a.budgetTokens !== null
                ? dim(
                    `${a.freshTokens.toLocaleString('en-US')} fresh tokens${a.budgetTokens !== null ? ` of ${a.budgetTokens.toLocaleString('en-US')}` : ''}`,
                  )
                : null}
              <Box flexDirection="row" marginTop={1} gap={1}>
                <Button
                  key="stop"
                  label="Stop timer"
                  hotkey="s"
                  onPress={() =>
                    act(
                      $,
                      ['stop', String(a.shortId)],
                      `stopped #${a.shortId}`,
                      `The user stopped the tasqx timer on #${a.shortId} ${quote(a.title)} from the pane.`,
                    )
                  }
                />
                {handoffButton(a, true, 'c')}
              </Box>
            </Box>,
            { color: 'suggestion', right: '▶ active' },
          )}

          {a.description ? card('desc', 'Description', <Markdown key="desc-md" text={a.description} />) : null}

          {a.checks.length > 0
            ? card(
                'checks',
                'Checks',
                <Box flexDirection="column">
                  {meter(passed / a.checks.length, Math.min(inner, 30), passed === a.checks.length ? 'success' : 'suggestion')}
                  {a.checks.map((c, i) => (
                    <Button
                      key={`check-${c.id}`}
                      plain
                      onPress={() => {
                        const to = lib.nextCheckState(c.state)
                        return act(
                          $,
                          ['check', 'set', String(a.shortId), String(i + 1), to],
                          `check ${i + 1} ${to}`,
                          `The user marked check ${i + 1} of #${a.shortId} (${quote(c.body)}) ${to} from the pane.`,
                        )
                      }}
                    >
                      <Text color={c.state === 'passed' ? 'success' : c.state === 'failed' ? 'error' : 'inactive'}>
                        {c.state === 'passed' ? '✔' : c.state === 'failed' ? '✘' : '○'}
                      </Text>{' '}
                      {c.body}
                    </Button>
                  ))}
                  {dim('press a check: open → passed → failed')}
                </Box>,
                { right: `${passed}/${a.checks.length}`, color: passed === a.checks.length ? 'success' : undefined },
              )
            : null}

          {a.dependsOn.length > 0 || a.blocks.length > 0
            ? card(
                'links',
                'Dependencies',
                <Box flexDirection="column">
                  {a.dependsOn.map(t => (
                    <Text key={`dep-${t.shortId}`} wrap="truncate-end">
                      {statusIcon(t.status)} <Text dimColor>needs #{t.shortId}</Text> {t.title}
                    </Text>
                  ))}
                  {a.blocks.map(t => (
                    <Text key={`blk-${t.shortId}`} wrap="truncate-end">
                      <Text color="suggestion">→</Text> <Text dimColor>unblocks #{t.shortId}</Text> {t.title}
                    </Text>
                  ))}
                </Box>,
              )
            : null}

          {a.latestNote
            ? card('note', 'Newest note', <Markdown key="note-md" text={a.latestNote.body} />, {
                right: `${lib.relativeTime(a.latestNote.created, now)} · ${a.noteCount} notes`,
              })
            : null}

          {snap.otherActive.length > 0
            ? card(
                'also',
                'Also active',
                <Box flexDirection="column">
                  {snap.otherActive.map(t => (
                    <Text key={`also-${t.shortId}`} wrap="truncate-end">
                      <Text color="suggestion">▶</Text> #{t.shortId} {t.title}
                    </Text>
                  ))}
                </Box>,
                { color: 'warning' },
              )
            : null}
        </Box>
      )
    }

    const queueTab = () => {
      if (snap.project === null) return noProject
      if (snap.queue.length === 0) return card('queue', 'Working set', dim('Nothing waiting.'))
      const more = snap.queueTotal - snap.queue.length
      return card(
        'queue',
        'Working set',
        <Box flexDirection="column">
          {snap.queue.map(t => (
            <Box key={`q-${t.shortId}`} flexDirection="row" gap={1}>
              {chip(t.priority ?? '-', t.blocked ? 'inactive' : lib.priorityColor(t.priority))}
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end" dimColor={t.blocked}>
                  <Text dimColor>#{t.shortId}</Text> {t.title}
                </Text>
                <Text wrap="truncate-end">
                  <Text dimColor>
                    {[
                      t.urgency.toFixed(1),
                      t.estimateSeconds ? lib.formatDuration(t.estimateSeconds) : null,
                      t.status === 'pending' ? null : t.status,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                  {t.due ? <Text color={Date.parse(t.due) < now ? 'error' : 'warning'}>{`  due ${lib.relativeTime(t.due, now)}`}</Text> : null}
                  {t.blocked ? <Text color="warning">{'  blocked'}</Text> : null}
                </Text>
              </Box>
              {t.blocked ? null : startButton(t)}
              {t.blocked ? null : handoffButton(t, false)}
            </Box>
          ))}
          {more > 0 ? dim(`…${more} more: tasqx list ${projectFilter(snap.project)} @working`) : null}
        </Box>,
        { right: `${snap.queueTotal} by urgency` },
      )
    }

    const projectTab = () => {
      if (snap.project === null) return noProject
      const sum = (pick: (s: StatusCount) => number, only?: (status: string) => boolean) =>
        snap.stats.filter(s => !only || only(s.status)).reduce((n, s) => n + pick(s), 0)
      const isOpen = (status: string) => status !== 'done' && status !== 'cancelled'
      const total = sum(s => s.count)
      const done = snap.stats.find(s => s.status === 'done')?.count ?? 0
      const open = sum(s => s.count, isOpen)
      const overdue = sum(s => s.overdue)
      const blocked = snap.queue.filter(t => t.blocked).length
      const left = sum(s => s.estimateSeconds, isOpen)
      const tracked = sum(s => s.trackedSeconds)
      const pct = total ? Math.round((done / total) * 100) : 0

      const days = snap.burndown.remaining
      const shown = Math.min(days.length, inner)
      const start = snap.burndown.from
        ? new Date(Date.parse(snap.burndown.from) + (days.length - shown) * 86_400_000).toISOString().slice(0, 10)
        : ''
      const peak = Math.max(0, ...days.slice(-shown))
      const chart =
        days.length === 0 ? (
          dim('No history yet.')
        ) : Raster ? (
          (() => {
            const drawn = lib.barCells(days, inner, 4, 0xd97757, 0x4eba65)
            return <Raster key="burndown" columns={drawn.columns} rows={4} cells={drawn.cells} />
          })()
        ) : (
          <Text color="suggestion">{lib.sparkline(days, inner)}</Text>
        )

      const row = (a: string, b: string, c: string, d: string) =>
        `${a.padEnd(10)}${b.padStart(6)}  ${c.padStart(9)}  ${d.padStart(10)}`

      return (
        <Box flexDirection="column">
          {card(
            'summary',
            snap.project,
            <Box flexDirection="column">
              {meter(total ? done / total : 0, inner, 'success')}
              <Text wrap="wrap">
                <Text bold>{done}</Text>
                <Text dimColor> done · </Text>
                <Text bold>{open}</Text>
                <Text dimColor> open · </Text>
                <Text bold>{left ? lib.formatDuration(left) : '—'}</Text>
                <Text dimColor> estimated left · </Text>
                <Text bold>{lib.formatDuration(tracked)}</Text>
                <Text dimColor> tracked</Text>
              </Text>
              {overdue > 0 || blocked > 0 ? (
                <Text>
                  {overdue > 0 ? chip(`${overdue} overdue`, 'error') : null}
                  {overdue > 0 && blocked > 0 ? ' ' : null}
                  {blocked > 0 ? chip(`${blocked} blocked`, 'warning') : null}
                </Text>
              ) : null}
            </Box>,
            { right: `${pct}% done`, color: 'success' },
          )}
          {card(
            'burndown-card',
            'Burndown',
            <Box flexDirection="column">
              {chart}
              {days.length > 0 ? (
                <Box flexDirection="row" justifyContent="space-between">
                  {dim(start)}
                  {dim(`peak ${peak}`)}
                  {dim('today')}
                </Box>
              ) : null}
            </Box>,
            { right: `${days[days.length - 1] ?? 0} open now` },
          )}
          {card(
            'statuses',
            'By status',
            <Box flexDirection="column">
              <Text dimColor>{row('status', 'tasks', 'estimate', 'tracked')}</Text>
              {snap.stats.map(s => (
                <Text key={`st-${s.status}`}>
                  {row(s.status, String(s.count), lib.formatDuration(s.estimateSeconds), lib.formatDuration(s.trackedSeconds))}
                </Text>
              ))}
            </Box>,
          )}
          {snap.recentDone.length > 0
            ? card(
                'recent',
                'Recently done',
                <Box flexDirection="column">
                  {snap.recentDone.map(t => (
                    <Text key={`done-${t.shortId}`} wrap="truncate-end">
                      <Text color="success">✔</Text> <Text dimColor>#{t.shortId}</Text> {t.title}
                    </Text>
                  ))}
                </Box>,
              )
            : null}
        </Box>
      )
    }

    const memoryTab = () => {
      const related = snap.active?.related ?? []
      return (
        <Box flexDirection="column">
          {snap.project === null
            ? noProject
            : card(
                'rulings',
                'Standing rulings',
                snap.rulings.length === 0 ? (
                  dim('None for this project.')
                ) : (
                  <Box flexDirection="column" gap={1}>
                    {snap.rulings.map((r, i) => (
                      <Box key={`rule-${i}`} flexDirection="column">
                        <Text bold wrap="wrap">
                          <Text color="suggestion">▌</Text> {r.title}
                        </Text>
                        <Text dimColor wrap="wrap">
                          {r.preview}
                        </Text>
                      </Box>
                    ))}
                  </Box>
                ),
                { right: String(snap.rulings.length) },
              )}
          {snap.active
            ? card(
                'related',
                `Related to #${snap.active.shortId}`,
                related.length === 0 ? (
                  dim('No memory hits.')
                ) : (
                  <Box flexDirection="column" gap={1}>
                    {related.map((hit, i) => (
                      <Box key={`hit-${i}`} flexDirection="column">
                        <Text bold wrap="wrap">
                          <Text color="suggestion">▌</Text> {hit.title}
                        </Text>
                        {dim(hit.source)}
                        <Text wrap="wrap">{hit.snippet}</Text>
                      </Box>
                    ))}
                  </Box>
                ),
              )
            : null}
        </Box>
      )
    }

    const body =
      current === 'queue' ? queueTab() : current === 'project' ? projectTab() : current === 'memory' ? memoryTab() : taskTab()

    return (
      <Box flexDirection="column">
        {header}
        {body}
      </Box>
    )
  })
}
