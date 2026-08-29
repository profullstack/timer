# timer, for agents

`timer` is a time tracker whose second audience is a program. This file is the
contract.

## The rules

1. **`--json` works on every command.** It prints one JSON document on stdout
   and nothing else.
2. **Advisories go to stderr.** `timer start` may warn that another clock is
   running; that never appears on stdout.
3. **A failed run prints nothing on stdout.** The error goes to stderr as
   `{"error": "...", "kind": "..."}`. Parsing stdout can never give you a
   success shape for a command that failed.
4. **Exit codes mean something.**

   | Code | Meaning |
   | --- | --- |
   | 0 | success |
   | 1 | runtime failure (unreadable timesheet, locked file) |
   | 2 | bad command line (unknown flag, missing argument, impossible range) |
   | 3 | you named an entry that does not exist |

5. **An unknown flag is an error**, never silently ignored. If `timer log
   --bogus` exits 0 you are on a different tool.

## The entry schema

Everything `--json` returns is built from this shape:

```json
{
  "id": "4f2ap8qk",
  "project": "acme",
  "task": "fix the login redirect",
  "tags": ["dev", "api"],
  "start": "2026-08-29T09:00:00.000Z",
  "end": "2026-08-29T10:30:00.000Z",
  "running": false,
  "seconds": 5400,
  "hours": 1.5,
  "billable": true,
  "rate": null,
  "agent": "claude-opus-5",
  "notes": "",
  "meta": {}
}
```

`end` is `null` while the clock runs, and `seconds` counts up to now.
`hours` is rounded to two decimals — it is the number that goes on an invoice.

## Clocking your own work

```sh
export TIMER_AGENT="claude-opus-5"
ID=$(timer start acme --task "refactor auth" --json | jq -r .started.id)
# ... do the work ...
timer stop --id "$ID" --json
```

Several clocks may run at once, which is the point: parallel agents each track
their own work and do not stop each other. Use `--switch` only if you mean to
close everyone else's clock.

If you did the work before you thought to time it, record it after the fact:

```sh
timer add acme --task "refactor auth" --duration 45m --json
```

## Attaching your own identifiers

`--meta` takes a JSON object and stores it unchanged:

```sh
timer add acme --duration 20m --meta '{"repo":"acme/api","pr":42}' --json
```

Filter later with `timer log --agent claude-opus-5 --json`.

## Reading the timesheet directly

If you would rather not shell out, the file is plain JSON at
`~/.profullstack/timer/timesheet.json` (or `$TIMER_DATA`):

```json
{ "version": 1, "entries": [ /* raw entries */ ] }
```

Two cautions. Raw entries have no `seconds`/`hours`/`running` — those are
computed. And writes are locked: if you write the file yourself while a `timer`
process is running you can lose an entry. Prefer the CLI for writes and the
file for reads.

## Billing the hours

`@profullstack/billing` reads the same file and will not bill the same entry
twice:

```sh
billing invoice new --client acme --from-timer --month --json
```
