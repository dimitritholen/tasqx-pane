import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActiveTask, Snapshot, Tab } from '../types'
import * as lib from './lib'

type Engine = EngineInterface

const PANE = 'tasqx'
const TABS: readonly Tab[] = ['task', 'queue', 'project', 'memory']
const TAB_LABEL: Record<Tab, string> = { task: 'Task', queue: 'Queue', project: 'Project', memory: 'Memory' }

const snapshot = atom({ plugin: 'tasqx-pane', key: 'snapshot' } as const, null)
const tab = atom({ plugin: 'tasqx-pane', key: 'tab' } as const, 'task')
const busy = atom({ plugin: 'tasqx-pane', key: 'busy' } as const, null)

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const projectFilter = (p: string) => `project:${/\s/.test(p) ? `"${p}"` : p}`

// Set from the plugin's options when the module registers.
const cfg = { bin: 'tasqx', override: '', autoOpen: true, showStatus: true, periodMs: 15_000 }

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
      const [queue, done, report, rulings] = await Promise.all([
        tasqx($, ['list', scope, '@working', '--limit', '15']),
        tasqx($, ['list', scope, 'status:done', '--sort', '-modified', '--limit', '5']),
        tasqx($, ['report', 'status', scope]),
        tasqx($, ['memory', 'list', '--project', project, '--standing', '--limit', '10']),
      ])
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

async function act($: Engine, args: string[], label: string) {
  await update($, busy, () => label)
  try {
    await tasqx($, args)
    $.ui.toast(`tasqx: ${label}`)
  } catch (err) {
    $.ui.toast(`tasqx: ${label} failed: ${message(err)}`)
  } finally {
    await update($, busy, () => null)
    await refresh($, true)
  }
}

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
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const current = await read($, tab)
    const working = await read($, busy)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns)
    // a snapshot read while the pane was closed lacks the queue: read it whole
    if (snap && !snap.isFull) $.clock.after(0, () => void refresh($, false, true))

    const heading = (text: string) => (
      <Text bold color="claude">
        {text}
      </Text>
    )
    const dim = (text: string) => <Text dimColor>{text}</Text>
    const gap = () => <Text> </Text>

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
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($, true)} />
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

    const updated = new Date(snap.fetchedAt).toTimeString().slice(0, 8)
    const scope =
      snap.project === null
        ? `no tasqx project named "${snap.dirName ?? '?'}"`
        : `${snap.project}${snap.projectSource === 'config' ? ' (from /config)' : ''}`
    const header = (
      <Box flexDirection="column">
        {tabs}
        <Text dimColor wrap="truncate-end">
          {scope} · updated {updated}
          {working ? ` · ${working}…` : ''}
        </Text>
        {gap()}
      </Box>
    )

    if (snap.error) {
      return (
        <Box flexDirection="column">
          {header}
          <Text color="error">{snap.error}</Text>
          {dim(`Is tasqx installed? Set its path under /config → tasqx-pane → tasqx binary (now "${cfg.bin}").`)}
        </Box>
      )
    }

    const noProject =
      snap.project === null
        ? dim(
            `Name a project after this folder (tasqx init ${snap.dirName ?? '<name>'}) or set one under /config → tasqx-pane → Project override.`,
          )
        : null

    const startButton = (shortId: number, hotkey?: string) => (
      <Button
        key={`start-${shortId}`}
        label="Start"
        hotkey={hotkey}
        onPress={() => act($, ['start', String(shortId)], `started #${shortId}`)}
      />
    )

    const taskTab = () => {
      const a = snap.active
      if (!a) {
        const top = snap.queue.find(t => !t.blocked)
        return (
          <Box flexDirection="column">
            {dim('No active task.')}
            {top && gap()}
            {top && heading('Next up')}
            {top && (
              <Text wrap="wrap">
                #{top.shortId} {top.title}
              </Text>
            )}
            {top &&
              dim(
                `${top.priority ?? '-'} · urgency ${top.urgency.toFixed(1)} · est ${lib.formatDuration(top.estimateSeconds)}`,
              )}
            {top && <Box>{startButton(top.shortId, 's')}</Box>}
            {noProject}
          </Box>
        )
      }

      const elapsed = a.trackedSeconds + Math.max(0, (now - snap.fetchedAt) / 1000)
      const ratio = a.estimateSeconds ? elapsed / a.estimateSeconds : 0
      const isOver = a.estimateSeconds !== null && ratio > 1
      const passed = a.checks.filter(c => c.state === 'passed').length
      const isOverdue = a.due !== null && Date.parse(a.due) < now
      const meta = [
        a.priority ? `priority ${a.priority}` : null,
        a.project,
        `urgency ${a.urgency.toFixed(1)}`,
        ...a.tags.map(t => `+${t}`),
      ].filter(Boolean)

      return (
        <Box flexDirection="column">
          <Text bold wrap="wrap">
            #{a.shortId} {a.title}
          </Text>
          {dim(meta.join(' · '))}
          <Text color={isOver ? 'warning' : undefined}>
            {lib.formatDuration(elapsed)}
            {a.estimateSeconds ? ` of ${lib.formatDuration(a.estimateSeconds)} ` : ' tracked'}
            {a.estimateSeconds ? lib.bar(ratio, Math.min(24, width - 24)) : ''}
            {a.estimateSeconds ? ` ${Math.round(ratio * 100)}%` : ''}
          </Text>
          {a.due && (
            <Text color={isOverdue ? 'error' : undefined}>
              Due {a.due.slice(0, 10)} ({lib.relativeTime(a.due, now)})
            </Text>
          )}
          {(a.freshTokens > 0 || a.budgetTokens !== null) &&
            dim(
              `${a.freshTokens.toLocaleString('en-US')} fresh tokens${a.budgetTokens !== null ? ` of ${a.budgetTokens.toLocaleString('en-US')} budget` : ''}`,
            )}
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Button
              key="stop"
              label="Stop timer"
              hotkey="s"
              onPress={() => act($, ['stop', String(a.shortId)], `stopped #${a.shortId}`)}
            />
          </Box>

          {a.description && gap()}
          {a.description && heading('Description')}
          {a.description && <Text wrap="wrap">{a.description}</Text>}

          {a.checks.length > 0 && gap()}
          {a.checks.length > 0 && heading(`Checks ${passed}/${a.checks.length}  ${lib.bar(passed / a.checks.length, 10)}`)}
          {a.checks.map((c, i) => (
            <Button
              key={`check-${c.id}`}
              plain
              onPress={() => {
                const to = lib.nextCheckState(c.state)
                return act($, ['check', 'set', String(a.shortId), String(i + 1), to], `check ${i + 1} ${to}`)
              }}
            >
              <Text color={c.state === 'passed' ? 'success' : c.state === 'failed' ? 'error' : undefined}>
                {c.state === 'passed' ? '[x]' : c.state === 'failed' ? '[!]' : '[ ]'}
              </Text>{' '}
              {c.body}
            </Button>
          ))}
          {a.checks.length > 0 && dim('Press a check to cycle open → passed → failed.')}

          {a.dependsOn.length > 0 && gap()}
          {a.dependsOn.length > 0 && heading('Depends on')}
          {a.dependsOn.map(t => (
            <Text key={`dep-${t.shortId}`} wrap="truncate-end" color={t.status === 'done' ? undefined : 'warning'}>
              #{t.shortId} {t.status} · {t.title}
            </Text>
          ))}
          {a.blocks.length > 0 && gap()}
          {a.blocks.length > 0 && heading('Unblocks')}
          {a.blocks.map(t => (
            <Text key={`blk-${t.shortId}`} wrap="truncate-end">
              #{t.shortId} {t.status} · {t.title}
            </Text>
          ))}

          {a.latestNote && gap()}
          {a.latestNote &&
            heading(`Newest note · ${lib.relativeTime(a.latestNote.created, now)} · ${a.noteCount} in all`)}
          {a.latestNote && <Text wrap="wrap">{a.latestNote.body}</Text>}

          {snap.otherActive.length > 0 && gap()}
          {snap.otherActive.length > 0 && heading('Also active')}
          {snap.otherActive.map(t => (
            <Text key={`also-${t.shortId}`} wrap="truncate-end">
              #{t.shortId} {t.title}
            </Text>
          ))}
        </Box>
      )
    }

    const queueTab = () => {
      if (snap.project === null) return <Box flexDirection="column">{noProject}</Box>
      if (snap.queue.length === 0) return dim('The working set is empty.')
      const more = snap.queueTotal - snap.queue.length
      return (
        <Box flexDirection="column">
          {heading(`Working set · ${snap.queueTotal} by urgency`)}
          {snap.queue.map(t => (
            <Box key={`q-${t.shortId}`} flexDirection="row" gap={1}>
              {startButton(t.shortId)}
              <Box flexDirection="column" flexShrink={1}>
                <Text wrap="truncate-end" dimColor={t.blocked}>
                  #{t.shortId} {t.title}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {[
                    t.priority ?? '-',
                    t.urgency.toFixed(1),
                    t.estimateSeconds ? `est ${lib.formatDuration(t.estimateSeconds)}` : null,
                    t.due ? `due ${lib.relativeTime(t.due, now)}` : null,
                    t.blocked ? 'blocked' : null,
                    t.status === 'pending' ? null : t.status,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </Box>
            </Box>
          ))}
          {more > 0 && dim(`…and ${more} more: tasqx list ${projectFilter(snap.project)} @working`)}
        </Box>
      )
    }

    const projectTab = () => {
      if (snap.project === null) return <Box flexDirection="column">{noProject}</Box>
      const total = snap.stats.reduce((n, s) => n + s.count, 0)
      const done = snap.stats.find(s => s.status === 'done')?.count ?? 0
      const open = snap.stats
        .filter(s => s.status !== 'done' && s.status !== 'cancelled')
        .reduce((n, s) => n + s.count, 0)
      const overdue = snap.stats.reduce((n, s) => n + s.overdue, 0)
      const blocked = snap.queue.filter(t => t.blocked).length
      const tracked = snap.stats.reduce((n, s) => n + s.trackedSeconds, 0)
      const remaining = snap.stats
        .filter(s => s.status !== 'done' && s.status !== 'cancelled')
        .reduce((n, s) => n + s.estimateSeconds, 0)
      const row = (a: string, b: string, c: string, d: string) =>
        `${a.padEnd(10)}${b.padStart(6)}  ${c.padStart(10)}  ${d.padStart(12)}`
      return (
        <Box flexDirection="column">
          {heading(`${snap.project} · ${done}/${total} done`)}
          <Text>{lib.bar(total ? done / total : 0, Math.min(30, width - 4))}</Text>
          {dim(
            `${open} open · ${remaining ? `${lib.formatDuration(remaining)} estimated left` : 'nothing estimated'} · ${lib.formatDuration(tracked)} tracked`,
          )}
          {overdue > 0 && <Text color="error">{overdue} overdue</Text>}
          {blocked > 0 && <Text color="warning">{blocked} blocked in the working set</Text>}
          {gap()}
          <Text dimColor>{row('status', 'tasks', 'estimate', 'tracked')}</Text>
          {snap.stats.map(s => (
            <Text key={`st-${s.status}`}>
              {row(
                s.status,
                String(s.count),
                lib.formatDuration(s.estimateSeconds),
                lib.formatDuration(s.trackedSeconds),
              )}
            </Text>
          ))}
          {snap.recentDone.length > 0 && gap()}
          {snap.recentDone.length > 0 && heading('Recently done')}
          {snap.recentDone.map(t => (
            <Text key={`done-${t.shortId}`} wrap="truncate-end">
              #{t.shortId} {t.title}
            </Text>
          ))}
        </Box>
      )
    }

    const memoryTab = () => {
      const related = snap.active?.related ?? []
      return (
        <Box flexDirection="column">
          {heading('Standing rulings')}
          {snap.project === null && noProject}
          {snap.project !== null && snap.rulings.length === 0 && dim('None for this project.')}
          {snap.rulings.map((r, i) => (
            <Box key={`rule-${i}`} flexDirection="column" marginBottom={1}>
              <Text bold wrap="wrap">
                {r.title}
              </Text>
              <Text dimColor wrap="wrap">
                {r.preview}
              </Text>
            </Box>
          ))}
          {snap.active && heading(`Related to #${snap.active.shortId}`)}
          {snap.active && related.length === 0 && dim('No memory hits.')}
          {related.map((h, i) => (
            <Box key={`hit-${i}`} flexDirection="column" marginBottom={1}>
              <Text bold wrap="wrap">
                {h.title}
              </Text>
              {dim(h.source)}
              <Text wrap="wrap">{h.snippet}</Text>
            </Box>
          ))}
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

