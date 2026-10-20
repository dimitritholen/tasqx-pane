# tasqx-pane

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that docks a **tasqx** pane beside the transcript, so you and Claude can see the work that is going on while the session runs.

It works in every repository whose folder name matches a [tasqx](https://github.com/dimitritholen/tasqx) project, or that you point at one with the project picker, and reads your store through the `tasqx` CLI.

```text
 [ Task ] [ Queue ] [ Project ] [ Memory ] [ ↻ ]
 tasqx-pane                              updated 15:12
╭──────────────────────────────────────────────────────╮
│ #2270                                       ▶ active │
│ tasqx-pane v0.1: a Claude Code mod showing the       │
│ active task, queue and project stats in a pane       │
│  H   tasqx-pane · urgency 6.0  +mod  +claude-code    │
│ ██████░░░░░░░░░░░░░░░░░░░░░░░░  32m / 3h 00m · 17%   │
│ [ Stop timer ] [ Hand to Claude ]                    │
╰──────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────╮
│ Checks                                           4/5 │
│ ████████████████████████░░░░░░                       │
│ ✔ claude plugin validate passes on the mod folder    │
│ ○ pane shows active task, checks, queue and stats    │
╰──────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────╮
│ Burndown                                  6 open now │
│ █▇                                                ▂  │
│ ██▆▃▁                                            ▃█  │
│ 2026-08-21           peak 53                   today │
╰──────────────────────────────────────────────────────╯
```

## What it shows

Each section is a card. Colors come from your Claude Code theme, so the pane reads in light and dark themes alike; red is kept for overdue tasks, failed checks and errors.


| Tab | Hotkey | What is on it |
| --- | --- | --- |
| **Task** | `t` | The project's active task (one from another project never shows): title, priority, tags, tracked time against the estimate, due date, token use against its budget, the description (its first note), the checks, what it depends on and unblocks, and the newest note. With no active task it shows the next one up, with a Start button. |
| **Queue** | `q` | The project's working set by urgency (blocked tasks dimmed), each with a Start button. |
| **Project** | `p` | Done/total with a progress bar, a burndown of open tasks over the last 60 days (a colored bar chart in the terminal, a sparkline in the desktop app and VS Code), open work, estimated time left, time tracked, overdue and blocked counts, a table per status, and the last five finished tasks. |
| **Memory** | `m` | The project's standing rulings, and the memory hits tasqx finds for the active task. |

Under the prompt a status line shows the active task, also while the pane is closed: `▶ #2270 42m / 3h 00m · 2/5 checks · tasqx-pane v0.1 …`

### What the pane can change

- **Start** a task from the queue, and **Stop timer** on the active one (`s`).
- **Hand to Claude** (`c`, or **→ Claude** on a queue row) starts the task's timer and puts a prompt in the prompt box, unsent: `Work on tasqx task #2265: <title>. Read its brief first.` Press Esc to get back to the prompt, change the text if you like, and press Enter. Claude never starts work you did not send.
- **Press a check** to cycle it open → passed → failed.

When you start or stop a timer or mark a check, the pane also leaves Claude a note it reads on its next turn, such as *the user started the tasqx timer on #2265*. The note starts no turn and does not show in the transcript, so Claude knows what you are working on without being asked to act. Turn it off with **Tell Claude** in `/config`.

It does not complete tasks. Completing one goes through your agent or `tasqx done`, so the delivery note gets written first.

### When it refreshes

Every 15 seconds (configurable), right after any `mcp__tasqx__*` tool call or Bash command that runs `tasqx`, and when you press Refresh (`r`). While the pane is closed it reads only the active task, for the status line.

## Install

You need Claude Code 2.1.287 or later, and `tasqx` installed.

At the prompt of a terminal session:

```text
/plugin install tasqx-pane --marketplace dimitritholen/tasqx-pane
```

Answer `y` to add the marketplace, then pick the **user** scope so it loads in every project.

From a shell:

```sh
claude plugin install tasqx-pane --marketplace dimitritholen/tasqx-pane
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `dimitritholen/tasqx-pane`, then **Add plugin**.

## Use

The pane opens by itself when a session starts in a repo that has a tasqx project and the terminal is wide enough: 144 columns or more, in fullscreen. At any width you can open it with:

```text
/tasqx-pane              open the pane
/tasqx-pane queue        open it on a tab: task, queue, project or memory
/tasqx-pane refresh      read tasqx again
/tasqx-pane close        close it
```

`ctrl+x tab` gives the pane the keyboard. The hotkeys then work, and the arrow keys scroll.

## Settings

Under `/config` → **tasqx-pane**:

| Setting | Default | What it does |
| --- | --- | --- |
| tasqx binary | `tasqx` | The executable to run. Give an absolute path (`~/.cargo/bin/tasqx`, `/opt/homebrew/bin/tasqx`) when Claude Code starts without your shell's `PATH`, as the desktop app can. |
| Project override | *(empty)* | Show this project in every folder that has no project picked in the pane. |
| Open on start | `on` | Open the pane when a session starts in a repo that has a project. |
| Status line | `on` | Show the active task under the prompt. |
| Refresh every (seconds) | `15` | How often it reads tasqx (at least 5). |
| Hand to Claude prompt | `Work on tasqx task #{id}: {title}. Read its brief first.` | What Hand to Claude puts in the prompt box. `{id}`, `{title}` and `{project}` are filled in. |
| Tell Claude | `on` | Leave Claude a note when you start or stop a timer or mark a check in the pane. |

## How it finds the project

It takes the name of the git repository's folder (the main worktree's for a linked worktree, or the session's folder outside git) and looks for a live tasqx project with that name, ignoring case. If there is none, the pane says so instead of showing another project.

The project name at the top of the pane is a picker: focus it, scroll the projects with the arrow keys or type to filter them, and press Enter to pick. The mouse wheel does not scroll it. The project you pick is remembered for that folder, across sessions, and wins over the folder name and **Project override**. A picked project that is archived or removed falls back to the folder name. Or create one with `tasqx init <folder name>`.

## Trust

A mod runs with your permissions and is not sandboxed. This one runs only the `tasqx` binary you configure: `list`, `brief`, `report`, `projects`, `chart burndown` and `memory list` to read, and `start`, `stop` and `check set` when you press a button. Besides that it fills your prompt box when you press Hand to Claude, and leaves Claude the notes described above. `claude plugin validate` on a clone lists every call it makes.

## Develop

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # a session with your working copy loaded
```

`hooks/lib.ts` holds the parsing and formatting and has no `$`, so `tests/lib.test.ts` covers it without a session. `tests/pane.test.tsx` draws the pane over a fake `tasqx` on the terminal and desktop surfaces.

## License

MIT
