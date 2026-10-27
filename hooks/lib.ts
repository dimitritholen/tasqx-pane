// Pure helpers: parsing tasqx's JSON and formatting it. No `$` here, so the
// tests reach every branch without a session.

import type { ActiveTask, InboxNote, MemoryHit, ProjectSource, QueueRow, StatusCount, TaskRef } from '../types'

type Json = any

/** "PT1H30M" / "P2DT3H" / "PT45.5S" → seconds; null for null or unparsable. */
export function parseDuration(iso: string | null | undefined): number | null {
  if (!iso) return null
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(iso)
  if (!m) return null
  const [, w, d, h, min, s] = m
  return (
    Number(w ?? 0) * 604800 +
    Number(d ?? 0) * 86400 +
    Number(h ?? 0) * 3600 +
    Number(min ?? 0) * 60 +
    Math.floor(Number(s ?? 0))
  )
}

/** Seconds → "2h 05m", "12m", "40s". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h === 0) return `${m}m`
  if (h >= 24 && m === 0) return `${h}h`
  return `${h}h ${String(m).padStart(2, '0')}m`
}

/** An instant relative to now: "in 2 days", "3 hours ago", "today". */
export function relativeTime(iso: string, nowMs: number): string {
  const diff = Date.parse(iso) - nowMs
  if (Number.isNaN(diff)) return iso
  const ahead = diff >= 0
  const mins = Math.round(Math.abs(diff) / 60000)
  const say = (n: number, unit: string) => {
    const word = `${n} ${unit}${n === 1 ? '' : 's'}`
    return ahead ? `in ${word}` : `${word} ago`
  }
  if (mins < 1) return 'just now'
  if (mins < 60) return say(mins, 'minute')
  const hours = Math.round(mins / 60)
  if (hours < 24) return say(hours, 'hour')
  return say(Math.round(hours / 24), 'day')
}

/** "[#####-----]" filled to ratio, at least 1 and at most `width` cells inside. */
export function bar(ratio: number, width: number): string {
  const cells = Math.max(1, width)
  const filled = Math.min(cells, Math.max(0, Math.round(ratio * cells)))
  return `[${'#'.repeat(filled)}${'-'.repeat(cells - filled)}]`
}

/** A Select takes 1 to 64 options: the first `room` values, `keep` (the current choice) always among them. */
export function pickerValues(values: string[], keep: string | null, room: number): string[] {
  const shown = [...new Set(values)].slice(0, room)
  // shortcut: values past `room` cannot be picked here, only by config or the tasqx CLI; upgrade to a search field if that bites
  if (keep && !shown.includes(keep)) shown.splice(Math.min(shown.length, room - 1), 1, keep)
  return shown
}

export function firstParagraph(body: string | null | undefined): string | null {
  if (!body) return null
  const para = body.trim().split(/\n\s*\n/)[0]?.trim()
  return para ? para : null
}

export function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/**
 * Which project to show: the one picked for this folder, else the override,
 * each only while it names a live project, else the project named after the
 * repository folder (case-insensitive), else none.
 */
export function pickProject(
  projects: readonly string[],
  dirName: string | null,
  override: string,
  chosen = '',
): { project: string | null; source: ProjectSource } {
  const find = (name: string) => projects.find(p => p.toLowerCase() === name.toLowerCase())
  if (chosen) {
    const hit = find(chosen)
    if (hit) return { project: hit, source: 'folder' }
  }
  const wanted = override.trim()
  if (wanted) {
    const hit = find(wanted)
    if (hit) return { project: hit, source: 'config' }
  }
  if (dirName) {
    const hit = find(dirName)
    if (hit) return { project: hit, source: 'repo' }
  }
  return { project: null, source: 'none' }
}

const taskRef = (t: Json): TaskRef => ({
  shortId: t.short_id,
  title: t.title ?? `#${t.short_id}`,
  status: t.status ?? '',
})

/** `tasqx brief <id> --json` → the pane's view of the active task. */
export function toActiveTask(brief: Json): ActiveTask {
  const t = brief.task
  const notes: Json[] = t.annotations ?? []
  // ponytail: the newest note is the last of the first page; a task with more
  // notes than one page shows the page's last. Fetch the last page if it matters.
  const last = notes.length > 1 ? notes[notes.length - 1] : null
  const near = brief.neighbourhood ?? {}
  const hits: Json[] = brief.memory?.hits ?? []
  return {
    shortId: t.short_id,
    title: t.title,
    project: t.project,
    priority: t.priority ?? null,
    urgency: t.urgency ?? 0,
    estimateSeconds: parseDuration(t.estimate),
    trackedSeconds: parseDuration(t.tracked) ?? 0,
    due: t.due ?? null,
    tags: t.tags ?? [],
    description: firstParagraph(t.first_annotation?.body),
    latestNote: last ? { body: firstParagraph(last.body) ?? '', created: last.created } : null,
    noteCount: t.annotations_total ?? notes.length,
    checks: (t.checks ?? []).map((c: Json) => ({ id: c.id, body: c.body, state: c.state })),
    dependsOn: (near.depends_on ?? []).map(taskRef),
    blocks: (near.blocks ?? []).map(taskRef),
    freshTokens: t.fresh_tokens ?? 0,
    budgetTokens: t.budget_tokens ?? null,
    related: hits.slice(0, 3).map(
      (h): MemoryHit => ({
        title: h.title ?? '',
        source: h.source ?? '',
        snippet: String(h.snippet ?? '').replace(/\s+/g, ' ').trim(),
      }),
    ),
  }
}

export function toQueueRow(t: Json): QueueRow {
  return {
    shortId: t.short_id,
    title: t.title,
    status: t.status,
    priority: t.priority ?? null,
    urgency: t.urgency ?? 0,
    blocked: t.blocked === true,
    due: t.due ?? null,
    estimateSeconds: parseDuration(t.estimate),
  }
}

export function toStats(report: Json): StatusCount[] {
  return (report.groups ?? []).map(
    (g: Json): StatusCount => ({
      status: g.status,
      count: g.count ?? 0,
      estimateSeconds: parseDuration(g.est_total) ?? 0,
      trackedSeconds: parseDuration(g.tracked_total) ?? 0,
      overdue: g.overdue ?? 0,
    }),
  )
}

export function toTaskRef(t: Json): TaskRef {
  return taskRef(t)
}

/** The status line: "▶ #2270 12m / 3h · 1/5 checks · tasqx-pane". */
export function statusText(active: ActiveTask, elapsedSeconds: number): string {
  const est = active.estimateSeconds ? ` / ${formatDuration(active.estimateSeconds)}` : ''
  const passed = active.checks.filter(c => c.state === 'passed').length
  const checks = active.checks.length ? ` · ${passed}/${active.checks.length} checks` : ''
  return `▶ #${active.shortId} ${formatDuration(elapsedSeconds)}${est}${checks} · ${active.title}`
}

/** What a press on a check sets it to: open → passed → failed → open. */
export function nextCheckState(state: string): 'open' | 'passed' | 'failed' {
  return state === 'open' ? 'passed' : state === 'passed' ? 'failed' : 'open'
}

/** Whether a finished tool call may have changed the store. */
export function touchesTasqx(tool: string, input: Json): boolean {
  if (tool.startsWith('mcp__tasqx__')) return true
  return tool === 'Bash' && /\btasqx\b/.test(String(input?.command ?? ''))
}

const EIGHTHS = ' ▁▂▃▄▅▆▇█'

/** The last `width` values, scaled so 0 is empty and the largest is full. */
function fit(values: readonly number[], width: number): { tail: number[]; max: number } {
  const tail = values.slice(-Math.max(1, width))
  return { tail, max: Math.max(1, ...tail) }
}

/** A one-row sparkline of eighth blocks, for surfaces without a Raster. */
export function sparkline(values: readonly number[], width: number): string {
  const { tail, max } = fit(values, width)
  return tail.map(v => EIGHTHS[Math.max(v > 0 ? 1 : 0, Math.round((v / max) * 8))]).join('')
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

export const DEFAULT_COLOR = 0x01000000

/**
 * A bar chart `rows` cells tall for a Raster: one column per value (the last
 * `columns` of them), eighth blocks stacked bottom-up, the last column in
 * `lastColor`. Returns the Raster's `cells` and how many columns it drew.
 */
export function barCells(
  values: readonly number[],
  columns: number,
  rows: number,
  color: number,
  lastColor: number,
): { cells: string; columns: number } {
  const { tail, max } = fit(values, columns)
  const words = new Uint32Array(tail.length * rows * 3)
  tail.forEach((v, x) => {
    const level = v > 0 ? Math.max(1, Math.round((v / max) * rows * 8)) : 0
    for (let r = 0; r < rows; r++) {
      const cell = Math.min(8, Math.max(0, level - (rows - 1 - r) * 8))
      const i = (r * tail.length + x) * 3
      words[i] = EIGHTHS.codePointAt(cell)!
      words[i + 1] = x === tail.length - 1 ? lastColor : color
      words[i + 2] = DEFAULT_COLOR
    }
  })
  return { cells: base64(new Uint8Array(words.buffer)), columns: tail.length }
}

/** A filled meter `width` cells wide: the filled and the empty part. */
export function meter(ratio: number, width: number): { filled: string; empty: string } {
  const cells = Math.max(1, width)
  const n = Math.min(cells, Math.max(0, Math.round(ratio * cells)))
  return { filled: '█'.repeat(n), empty: '░'.repeat(cells - n) }
}

/** The theme color for a priority chip. */
// No red here: red on a pane's grey reads poorly. Red is kept for overdue and failed.
export function priorityColor(priority: string | null): 'warning' | 'suggestion' | 'inactive' {
  return priority === 'H' ? 'warning' : priority === 'M' ? 'suggestion' : 'inactive'
}

/** The handoff prompt: `{id}`, `{title}` and `{project}` filled in. */
export function handoffText(template: string, task: { shortId: number; title: string; project: string | null }): string {
  return template
    .replaceAll('{id}', String(task.shortId))
    .replaceAll('{title}', task.title)
    .replaceAll('{project}', task.project ?? '')
}

/** Every tag on these tasks, once each, sorted. */
export function collectTags(tasks: Json[]): string[] {
  return [...new Set<string>(tasks.flatMap(t => t.tags ?? []))].sort()
}

/** The prompt that hands every task under a tag to Claude, most urgent first. */
export function tagHandoffText(filter: string, ids: number[]): string {
  const now = ids.length > 0 ? ` (now ${ids.map(id => `#${id}`).join(', ')})` : ''
  return `Work through the tasqx tasks in \`${filter}\`, most urgent first${now}. Read each brief first and finish one before you start the next.`
}

/**
 * The tasqx task a subagent's prompt is about: the first of `tasqx show <id>`,
 * `task/<id>-` (a branch) or `tasqx task #<id>`; null when it names none.
 */
export function taskIdIn(prompt: string): number | null {
  const m = /\btasqx show (\d+)\b|\btask\/(\d+)-|\btasqx task #(\d+)\b/i.exec(prompt)
  return m ? Number(m[1] ?? m[2] ?? m[3]) : null
}

/**
 * The prompt section for standing rulings of `project` (or unscoped) created or
 * changed after `sinceMs`: title plus first body line each; null when none.
 */
export function liveRulingsText(docs: readonly Json[], project: string | null, sinceMs: number): string | null {
  const fresh = docs.filter(
    d =>
      d.standing !== false &&
      (d.project == null || (project !== null && String(d.project).toLowerCase() === project.toLowerCase())) &&
      Date.parse(d.modified ?? d.created) > sinceMs,
  )
  if (fresh.length === 0) return null
  const lines = fresh.map(d => {
    const first = String(d.body_preview ?? '').split('\n').find(l => l.trim())?.trim()
    return `- ${d.title}${first ? `: ${first}` : ''}`
  })
  return ['Standing rulings added during this session — follow them:', ...lines].join('\n')
}

/** A note from `tasqx notes --json`. */
export function toInboxNote(n: Json): InboxNote {
  return {
    shortId: Number(n.short_id),
    body: String(n.body ?? ''),
    hasLinks: Boolean(n.has_links),
    created: String(n.created ?? ''),
  }
}

// Ported from tasqx-desktop's state/notes.ts, so a link reads the same in both.
// A link runs to the next whitespace or quote; the scheme is case-sensitive, as `has_links` is.
const LINK_RE = /https?:\/\/[^\s<>"']+/g
const TRAILING = '.,;:!?)]}'
// C0, DEL and C1 controls
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/

/** Trailing punctuation is prose, except a `)` closing a `(` inside the link. */
function trimTrailing(href: string): string {
  let end = href.length
  while (end > 0 && TRAILING.includes(href[end - 1]!)) {
    const head = href.slice(0, end)
    if (head.endsWith(')') && head.split('(').length > head.split(')').length - 1) break
    end -= 1
  }
  return href.slice(0, end)
}

/** No userinfo (`https://google.com@evil.com/` reads as one host and goes to another), backslash or control character; `Link` takes 2048 characters. */
function openable(href: string): boolean {
  const authority = href.slice(href.indexOf('//') + 2).split(/[/?#]/)[0] ?? ''
  return (
    /^https?:\/\/[^/]/.test(href) && !authority.includes('@') && !href.includes('\\') && !CONTROL_RE.test(href) && href.length <= 2048
  )
}

export type BodySegment = { text: string; href?: string }

/** A note body cut into plain text and the http(s) links in it, in order; a link it refuses stays text. */
export function splitLinks(body: string): BodySegment[] {
  const segments: BodySegment[] = []
  let at = 0
  for (const match of body.matchAll(LINK_RE)) {
    const href = trimTrailing(match[0])
    if (!openable(href)) continue
    const start = match.index ?? 0
    if (start > at) segments.push({ text: body.slice(at, start) })
    segments.push({ text: href, href })
    at = start + href.length
  }
  if (at < body.length || segments.length === 0) segments.push({ text: body.slice(at) })
  return segments
}
