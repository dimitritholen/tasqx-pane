export type CheckState = 'open' | 'passed' | 'failed'

export type Check = { id: string; body: string; state: CheckState }

export type TaskRef = { shortId: number; title: string; status: string }

export type Note = { body: string; created: string }

export type MemoryHit = { title: string; source: string; snippet: string }

export type ActiveTask = {
  shortId: number
  title: string
  project: string
  priority: string | null
  urgency: number
  estimateSeconds: number | null
  trackedSeconds: number
  due: string | null
  tags: string[]
  description: string | null
  latestNote: Note | null
  noteCount: number
  checks: Check[]
  dependsOn: TaskRef[]
  blocks: TaskRef[]
  freshTokens: number
  budgetTokens: number | null
  related: MemoryHit[]
}

export type QueueRow = {
  shortId: number
  title: string
  status: string
  priority: string | null
  urgency: number
  blocked: boolean
  due: string | null
  estimateSeconds: number | null
}

export type StatusCount = {
  status: string
  count: number
  estimateSeconds: number
  trackedSeconds: number
  overdue: number
}

export type Ruling = { title: string; preview: string }

export type ProjectSource = 'repo' | 'config' | 'none'

export type Snapshot = {
  project: string | null
  projectSource: ProjectSource
  dirName: string | null
  active: ActiveTask | null
  otherActive: TaskRef[]
  queue: QueueRow[]
  queueTotal: number
  recentDone: TaskRef[]
  stats: StatusCount[]
  rulings: Ruling[]
  fetchedAt: number
  /** False when only the active task was read (the pane was closed). */
  isFull: boolean
  error: string | null
}

export type Tab = 'task' | 'queue' | 'project' | 'memory'

declare module 'claude-code' {
  interface PluginState {
    'tasqx-pane': { snapshot: Snapshot | null; tab: Tab; busy: string | null }
  }
}
