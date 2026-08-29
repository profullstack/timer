# timer

Track time against projects, from the terminal, on Linux, macOS and Windows.

It is a stopwatch with a memory: start a clock on a project, stop it, and get
billable hours back. Every command also speaks `--json`, so a coding agent can
clock its own work the same way you do — and
[`@profullstack/billing`](https://github.com/profullstack/billing) turns those
hours into invoices.

```sh
npm install -g @profullstack/timer
```

Node 20.11 or newer. No runtime dependencies.

## Use it

```sh
timer start acme fix the login redirect     # everything after the project is the task
timer status                                # what is running, and today's total
timer stop

timer add acme code review --duration 45m   # time you forgot to clock
timer add acme --from 09:00 --to 11:30

timer log --week                            # what happened
timer report --month --group project        # what it adds up to
timer projects                              # everything you have ever tracked
```

Nothing is configured before first use. The timesheet appears the first time
you start a clock.

## Commands

| Command | What it does |
| --- | --- |
| `start <project> [task…]` | Start a clock. `--at 09:15`, `--at -20m`, `--tag`, `--note`, `--rate`, `--switch` |
| `stop [id]` | Stop the newest clock, an id, `--project <p>`, or `--all` |
| `status` | Running clocks and today's total |
| `log [project]` | List entries in a window |
| `add <project> [task…]` | Record untimed work from two of `--from` / `--to` / `--duration` |
| `edit <id>` | Change any field of an entry |
| `rm <id…>` | Delete entries (`--force` for a running one) |
| `resume [id]` | Start a fresh clock like the last one |
| `note <text…>` | Append a note to the running clock |
| `report` | Totals, `--group project\|task\|tag\|day\|agent\|none` |
| `projects` | Projects seen, with totals and last activity |
| `export` | `--format json\|ndjson\|csv`, `--out <file>` |
| `config` | Where the timesheet lives |

`timer help <command>` prints the flags and examples for one command.

### Windows of time

`log`, `report`, `projects` and `export` all take the same window flags:
`--today`, `--yesterday`, `--week` (from Monday), `--month`, `--year`, or an
explicit `--since` / `--until`.

Dates are loose on purpose: `09:15`, `2026-08-01`, `-2h`, `yesterday`, or a
full ISO instant. A bare date means local midnight, not UTC midnight.

A window compares against the entry's **start**, and `--until` is exclusive. An
entry that runs past midnight therefore belongs to the day it began on — which
is what keeps a total from being counted twice.

### Billable and not

Every entry is billable unless you say otherwise with `--no-billable`. Reports
carry both numbers, because "how long did this take" and "what can I charge for
it" are different questions:

```sh
timer add internal standup --duration 15m --no-billable
timer report --month
```

## For agents

Two things make this usable by an agentic CLI without a wrapper.

**Every command answers `--json`** with a single JSON document on stdout and
nothing else. Advisory lines go to stderr. A command that fails prints its
error as JSON on **stderr** and leaves stdout empty, so parsing stdout can
never yield a success shape for a failed run.

**Exit codes are distinct**: `0` success, `1` a runtime failure, `2` a bad
command line, `3` you named something that is not there. `timer stop` with no
clock running is a `0` — that is an answer, not a failure.

```sh
export TIMER_AGENT="claude-opus-5"            # stamps every entry it creates
timer start acme --task "refactor auth" --json
timer stop --json
timer log --today --json
```

`--meta '{"pr":42}'` hangs your own identifiers off an entry, and they survive
round-trip unchanged.

There is more detail, including the entry schema, in [AGENTS.md](AGENTS.md).

## Where the data lives

One JSON file, in one place on every platform:

```
~/.profullstack/timer/timesheet.json
```

| Variable | Overrides |
| --- | --- |
| `TIMER_DATA` | the timesheet file itself |
| `TIMER_HOME` | the directory it sits in |
| `PROFULLSTACK_HOME` | the parent shared with other Profullstack CLIs |
| `TIMER_AGENT` | the agent name stamped on new entries |
| `NO_COLOR` | turns off colour |

`timer config` prints all of it. The file is plain JSON you can read and edit;
writes are atomic and locked, so several agents can clock in at once without
losing an entry.

## With billing

`@profullstack/billing` reads this file directly — it does not need `timer` on
`PATH` — and turns unbilled hours into invoice line items:

```sh
billing invoice new --client acme --from-timer --month
```

## In moshcode

[moshcode](https://github.com/moshcoder/moshcode) installs and fronts it:

```
moshcode install timer
/timer start acme fix the login redirect
```

## Licence

MIT © Profullstack, LLC
