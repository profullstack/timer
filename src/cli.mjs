// The command surface.
//
// One table, one dispatcher. Each command declares the flags it takes, which
// is what lets `--help` and the arg parser stay in agreement — a flag that is
// documented but not declared would silently land in `unknown` and be ignored,
// and that is exactly the failure an agent cannot see.
import fs from "node:fs";

import { GLOBAL_ALIASES, GLOBAL_BOOLEANS, GLOBAL_VALUES, parseArgs } from "./args.mjs";
import { dataFile, timerHome } from "./paths.mjs";
import { read, update } from "./store.mjs";
import { csv, emit, emitJson, paint, table, warn } from "./output.mjs";
import {
  GROUP_KEYS,
  boundsFromDuration,
  closeEntry,
  findById,
  isRunning,
  makeEntry,
  seconds,
  select,
  summarize,
  totals,
} from "./entries.mjs";
import { formatDuration, hours, parseMoment, resolveWindow, shortStamp } from "./time.mjs";

export const VERSION = "0.2.0";

/** A bad command line — worth a different exit code than a failed operation. */
export class UsageError extends Error {
  constructor(message) { super(message); this.name = "UsageError"; this.exitCode = 2; }
}
/** The thing you named is not there. */
export class NotFoundError extends Error {
  constructor(message) { super(message); this.name = "NotFoundError"; this.exitCode = 3; }
}

// Selection flags are shared by every command that reads a range of entries,
// so they are declared once and spliced in below.
const SELECT_BOOLEANS = ["today", "yesterday", "week", "month", "year", "billable", "running", "done"];
const SELECT_VALUES = ["project", "task", "agent", "since", "until", "period"];
const SELECT_MULTI = ["tag", "id"];

function selectionFrom(flags, entries) {
  const { since, until } = resolveWindow(flags);
  return select(entries, {
    project: flags.project,
    task: flags.task,
    tag: flags.tag,
    agent: flags.agent,
    since,
    until,
    billable: "billable" in flags ? flags.billable : undefined,
    ids: flags.id,
    runningOnly: flags.running,
    finishedOnly: flags.done,
  });
}

/** The public shape of an entry — what --json prints and what billing reads. */
function serialize(entry, now = new Date()) {
  const secs = seconds(entry, now);
  return {
    id: entry.id,
    project: entry.project,
    task: entry.task,
    tags: entry.tags,
    start: entry.start,
    end: entry.end,
    running: isRunning(entry),
    seconds: secs,
    hours: hours(secs),
    billable: entry.billable,
    rate: entry.rate,
    agent: entry.agent,
    agents: entry.agents ?? 1,
    agentHours: hours(secs * (entry.agents ?? 1)),
    notes: entry.notes,
    meta: entry.meta,
  };
}

const ENTRY_COLUMNS = [
  { header: "ID", get: (e) => e.id },
  { header: "STARTED", get: (e) => shortStamp(e.start) },
  { header: "PROJECT", get: (e) => e.project },
  { header: "TASK", get: (e) => e.task || "-" },
  { header: "TIME", get: (e) => formatDuration(e.seconds), align: "right" },
  { header: "AGENTS", get: (e) => (e.agents > 1 ? e.agents : "") , align: "right" },
  { header: "TAGS", get: (e) => (e.tags.length ? e.tags.join(",") : "-") },
  { header: "", get: (e) => (e.running ? "running" : (e.billable ? "" : "unbillable")) },
];

function printEntries(rows, flags) {
  if (flags.json) return emitJson({ entries: rows, totals: sumOf(rows) });
  if (!rows.length) { if (!flags.quiet) warn("no entries match"); return; }
  emit(table(rows, ENTRY_COLUMNS, { dimCols: ["ID", "TAGS"] }));
  if (!flags.quiet) {
    const t = sumOf(rows);
    emit("");
    emit(`${rows.length} ${rows.length === 1 ? "entry" : "entries"}  ${paint("bold", formatDuration(t.seconds))}`
      + (t.billableSeconds !== t.seconds ? `  (${formatDuration(t.billableSeconds)} billable)` : "")
      + `  ${paint("dim", `${hours(t.billableSeconds)}h billable`)}`);
  }
}

function sumOf(rows) {
  const secs = rows.reduce((n, r) => n + r.seconds, 0);
  const billable = rows.filter((r) => r.billable).reduce((n, r) => n + r.seconds, 0);
  return { entries: rows.length, seconds: secs, hours: hours(secs), billableSeconds: billable, billableHours: hours(billable) };
}

/**
 * How many agents were working, from --agents.
 *
 * A number only. moshcode's `--agents auto` reads the count off its own herd
 * and passes the result here: this package has no herd to ask, and silently
 * treating "auto" as 1 would under-bill every entry it appeared on.
 */
function agentCount(flags) {
  if (flags.agents == null) return 1;
  const n = Number(flags.agents);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    throw new UsageError(
      `--agents: "${flags.agents}" is not a whole number of agents`
      + (String(flags.agents).toLowerCase() === "auto"
        ? " (this package has no herd to count; pass the number)" : ""),
    );
  }
  return n;
}

function requireProject(positional, flags) {
  const project = flags.project || positional[0];
  if (!project) throw new UsageError("which project? e.g. timer start acme");
  return project;
}

// ---------------------------------------------------------------------------

const COMMANDS = [
  {
    name: "start",
    aliases: ["begin", "in", "on"],
    args: "<project> [task words…]",
    summary: "start the clock on a project",
    booleans: ["billable", "switch"],
    values: ["task", "note", "agent", "agents", "rate", "at", "project", "meta"],
    multi: ["tag"],
    detail: [
      "Everything after the project name is taken as the task, so you can type",
      "  timer start acme fix the login redirect",
      "without quoting. --at accepts 09:15, -20m or an ISO instant, for the clock",
      "you meant to start earlier.",
      "",
      "Several clocks may run at once — that is deliberate, because parallel agents",
      "each track their own work. Use --switch to stop the others first.",
    ],
    run({ positional, flags, file }) {
      const project = requireProject(positional, flags);
      const task = flags.task || positional.slice(flags.project ? 0 : 1).join(" ");
      const at = flags.at ? parseMoment(flags.at) : new Date().toISOString();
      if (flags.at && !at) throw new UsageError(`--at: cannot read "${flags.at}" as a time`);
      let meta = {};
      if (flags.meta) {
        try { meta = JSON.parse(flags.meta); } catch { throw new UsageError("--meta must be a JSON object"); }
      }
      const result = update((store) => {
        const stopped = [];
        if (flags.switch) {
          for (const e of store.entries.filter(isRunning)) { closeEntry(e, at); stopped.push(e.id); }
        }
        const entry = makeEntry({
          project,
          task,
          tags: flags.tag || [],
          start: at,
          notes: flags.note || "",
          agent: flags.agent || process.env.TIMER_AGENT || null,
          agents: agentCount(flags),
          rate: flags.rate,
          billable: flags.billable !== false,
          meta,
        });
        store.entries.push(entry);
        const others = store.entries.filter((e) => isRunning(e) && e.id !== entry.id);
        return { entry, stopped, others: others.map((e) => e.id) };
      }, { file });

      if (flags.json) return emitJson({ started: serialize(result.entry), stopped: result.stopped, alsoRunning: result.others });
      if (!flags.quiet) {
        emit(`${paint("green", "started")} ${result.entry.project}`
          + (result.entry.task ? ` — ${result.entry.task}` : "")
          + `  ${paint("dim", result.entry.id)}`);
        if (result.stopped.length) emit(paint("dim", `stopped ${result.stopped.length} other clock(s)`));
        else if (result.others.length) warn(`note: ${result.others.length} other clock(s) still running — timer status`);
      }
    },
  },
  {
    name: "stop",
    aliases: ["out", "off"],
    args: "[id]",
    summary: "stop a running clock",
    booleans: ["all"],
    values: ["at", "note", "project"],
    multi: ["id"],
    detail: [
      "With no argument it stops the most recently started clock. --all stops every",
      "running clock, --project stops the ones on that project, and an id (or any",
      "unambiguous prefix of one) stops exactly that entry.",
    ],
    run({ positional, flags, file }) {
      const at = flags.at ? parseMoment(flags.at) : new Date().toISOString();
      if (flags.at && !at) throw new UsageError(`--at: cannot read "${flags.at}" as a time`);
      const wanted = [...(flags.id || []), ...positional];
      const result = update((store) => {
        const live = store.entries.filter(isRunning);
        if (!live.length) return { stopped: [] };
        let targets;
        if (wanted.length) {
          targets = wanted.map((id) => {
            const found = findById(store.entries, id);
            if (!found) throw new NotFoundError(`no entry with id "${id}"`);
            if (!isRunning(found)) throw new UsageError(`entry ${found.id} is already stopped`);
            return found;
          });
        } else if (flags.all) {
          targets = live;
        } else if (flags.project) {
          targets = live.filter((e) => e.project.toLowerCase() === String(flags.project).toLowerCase());
          if (!targets.length) throw new NotFoundError(`nothing running on project "${flags.project}"`);
        } else {
          targets = [live.reduce((a, b) => (a.start > b.start ? a : b))];
        }
        for (const t of targets) {
          closeEntry(t, at);
          if (flags.note) t.notes = t.notes ? `${t.notes}\n${flags.note}` : flags.note;
        }
        return { stopped: targets };
      }, { file });

      if (!result.stopped.length) {
        if (flags.json) return emitJson({ stopped: [], message: "no clock was running" });
        if (!flags.quiet) warn("no clock was running");
        return;
      }
      const rows = result.stopped.map((e) => serialize(e));
      if (flags.json) return emitJson({ stopped: rows, totals: sumOf(rows) });
      if (!flags.quiet) {
        for (const r of rows) {
          emit(`${paint("green", "stopped")} ${r.project}${r.task ? ` — ${r.task}` : ""}`
            + `  ${paint("bold", formatDuration(r.seconds))}  ${paint("dim", `${r.hours}h · ${r.id}`)}`);
        }
      }
    },
  },
  {
    name: "status",
    aliases: ["st", "now"],
    summary: "what is running, and today's total",
    booleans: [],
    values: [],
    detail: [
      "Exit status is 0 whether or not a clock is running — 'nothing running' is an",
      "answer, not a failure. Check the `running` array in --json instead.",
    ],
    run({ flags, file }) {
      const store = read(file);
      const now = new Date();
      const live = store.entries.filter(isRunning).map((e) => serialize(e, now));
      const { since, until } = resolveWindow({ today: true }, { now });
      const today = select(store.entries, { since, until }).map((e) => serialize(e, now));

      if (flags.json) {
        return emitJson({ running: live, today: sumOf(today), dataFile: file });
      }
      if (!live.length) emit(paint("dim", "no clock running"));
      else {
        for (const r of live) {
          emit(`${paint("green", "*")} ${r.project}${r.task ? ` — ${r.task}` : ""}`
            + `  ${paint("bold", formatDuration(r.seconds))}`
            + `  ${paint("dim", `since ${shortStamp(r.start)} · ${r.id}`)}`);
        }
      }
      const t = sumOf(today);
      emit(paint("dim", `today: ${formatDuration(t.seconds)} across ${t.entries} ${t.entries === 1 ? "entry" : "entries"}`
        + (t.billableSeconds !== t.seconds ? ` (${formatDuration(t.billableSeconds)} billable)` : "")));
    },
  },
  {
    name: "log",
    aliases: ["ls", "list", "entries"],
    args: "[project]",
    summary: "list entries",
    booleans: [...SELECT_BOOLEANS, "reverse"],
    values: [...SELECT_VALUES, "limit"],
    multi: SELECT_MULTI,
    detail: [
      "`timer log --json` is the stable contract other tools read — @profullstack/billing",
      "builds invoice line items from exactly this shape.",
      "",
      "Windows: --today, --yesterday, --week (from Monday), --month, --year, or an",
      "explicit --since/--until. A bound compares against the entry's start, and",
      "--until is exclusive, so an entry belongs to the day it began on.",
    ],
    run({ positional, flags, file }) {
      const store = read(file);
      if (positional[0] && !flags.project) flags.project = positional[0];
      let rows = selectionFrom(flags, store.entries).map((e) => serialize(e));
      rows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      if (flags.reverse) rows.reverse();
      if (flags.limit) {
        const n = Number(flags.limit);
        if (!Number.isFinite(n) || n <= 0) throw new UsageError("--limit must be a positive number");
        rows = rows.slice(-n);
      }
      printEntries(rows, flags);
    },
  },
  {
    name: "add",
    args: "<project> [task words…]",
    summary: "record time you did not clock",
    booleans: ["billable"],
    values: ["from", "to", "duration", "task", "note", "agent", "agents", "rate", "project", "meta"],
    multi: ["tag"],
    detail: [
      "Give any two of --from, --to and --duration; with only --duration the entry",
      "ends now. Times accept 09:15, 2026-08-01, -2h or a full ISO instant.",
      "",
      "  timer add acme code review --duration 45m",
      "  timer add acme --from 09:00 --to 11:30",
    ],
    run({ positional, flags, file }) {
      const project = requireProject(positional, flags);
      const task = flags.task || positional.slice(flags.project ? 0 : 1).join(" ");
      const now = new Date();
      const from = flags.from ? parseMoment(flags.from, { now }) : null;
      const to = flags.to ? parseMoment(flags.to, { now }) : null;
      if (flags.from && !from) throw new UsageError(`--from: cannot read "${flags.from}" as a time`);
      if (flags.to && !to) throw new UsageError(`--to: cannot read "${flags.to}" as a time`);
      if (!flags.duration && !(from && to)) {
        throw new UsageError("give two of --from, --to and --duration");
      }
      let bounds;
      try {
        bounds = boundsFromDuration({ start: from, end: to, duration: flags.duration, now });
      } catch (err) { throw new UsageError(err.message); }
      if (!bounds.start || !bounds.end) throw new UsageError("give two of --from, --to and --duration");
      if (bounds.end < bounds.start) throw new UsageError("the entry would end before it started");
      let meta = {};
      if (flags.meta) {
        try { meta = JSON.parse(flags.meta); } catch { throw new UsageError("--meta must be a JSON object"); }
      }
      const entry = update((store) => {
        const e = makeEntry({
          project,
          task,
          tags: flags.tag || [],
          start: bounds.start,
          end: bounds.end,
          notes: flags.note || "",
          agent: flags.agent || process.env.TIMER_AGENT || null,
          agents: agentCount(flags),
          rate: flags.rate,
          billable: flags.billable !== false,
          meta,
        });
        store.entries.push(e);
        return e;
      }, { file });
      const row = serialize(entry);
      if (flags.json) return emitJson({ added: row });
      if (!flags.quiet) {
        emit(`${paint("green", "added")} ${row.project}${row.task ? ` — ${row.task}` : ""}`
          + `  ${paint("bold", formatDuration(row.seconds))}  ${paint("dim", `${row.hours}h · ${row.id}`)}`);
      }
    },
  },
  {
    name: "edit",
    args: "<id>",
    summary: "change an entry",
    booleans: ["billable"],
    values: ["project", "task", "note", "agent", "agents", "rate", "from", "to", "duration", "meta"],
    multi: ["tag"],
    detail: ["Only the fields you name change. --tag replaces the whole tag list."],
    run({ positional, flags, file }) {
      const id = positional[0];
      if (!id) throw new UsageError("which entry? e.g. timer edit 4f2a --task 'billing bug'");
      const entry = update((store) => {
        const e = findById(store.entries, id);
        if (!e) throw new NotFoundError(`no entry with id "${id}"`);
        const now = new Date();
        if (flags.project) e.project = flags.project;
        if (flags.task != null) e.task = flags.task;
        if (flags.note != null) e.notes = flags.note;
        if (flags.agent != null) e.agent = flags.agent || null;
        if (flags.agents != null) e.agents = agentCount(flags);
        if (flags.rate != null) e.rate = Number(flags.rate);
        if ("billable" in flags) e.billable = Boolean(flags.billable);
        if (flags.tag) e.tags = [...new Set(flags.tag)];
        if (flags.meta) {
          try { e.meta = JSON.parse(flags.meta); } catch { throw new UsageError("--meta must be a JSON object"); }
        }
        if (flags.from) {
          const v = parseMoment(flags.from, { now });
          if (!v) throw new UsageError(`--from: cannot read "${flags.from}" as a time`);
          e.start = v;
        }
        if (flags.to) {
          const v = parseMoment(flags.to, { now });
          if (!v) throw new UsageError(`--to: cannot read "${flags.to}" as a time`);
          e.end = v;
        }
        if (flags.duration) {
          const b = boundsFromDuration({ start: e.start, duration: flags.duration, now });
          e.end = b.end;
        }
        if (e.end && e.end < e.start) throw new UsageError("that would end the entry before it started");
        return e;
      }, { file });
      const row = serialize(entry);
      if (flags.json) return emitJson({ updated: row });
      if (!flags.quiet) emit(`${paint("green", "updated")} ${row.id}  ${row.project}${row.task ? ` — ${row.task}` : ""}  ${formatDuration(row.seconds)}`);
    },
  },
  {
    name: "rm",
    aliases: ["remove", "delete"],
    args: "<id…>",
    summary: "delete entries",
    booleans: ["force"],
    values: [],
    multi: ["id"],
    run({ positional, flags, file }) {
      const wanted = [...(flags.id || []), ...positional];
      if (!wanted.length) throw new UsageError("which entry? e.g. timer rm 4f2a");
      const removed = update((store) => {
        const gone = [];
        for (const id of wanted) {
          const e = findById(store.entries, id);
          if (!e) throw new NotFoundError(`no entry with id "${id}"`);
          if (isRunning(e) && !flags.force) {
            throw new UsageError(`entry ${e.id} is still running — stop it first, or pass --force`);
          }
          store.entries.splice(store.entries.indexOf(e), 1);
          gone.push(e);
        }
        return gone;
      }, { file });
      const rows = removed.map((e) => serialize(e));
      if (flags.json) return emitJson({ removed: rows });
      if (!flags.quiet) for (const r of rows) emit(`${paint("red", "removed")} ${r.id}  ${r.project}${r.task ? ` — ${r.task}` : ""}`);
    },
  },
  {
    name: "resume",
    aliases: ["again"],
    args: "[id]",
    summary: "start a new clock like the last one",
    booleans: ["switch"],
    values: ["project", "at"],
    run({ positional, flags, file }) {
      const at = flags.at ? parseMoment(flags.at) : new Date().toISOString();
      if (flags.at && !at) throw new UsageError(`--at: cannot read "${flags.at}" as a time`);
      const entry = update((store) => {
        let source;
        if (positional[0]) {
          source = findById(store.entries, positional[0]);
          if (!source) throw new NotFoundError(`no entry with id "${positional[0]}"`);
        } else {
          const pool = flags.project
            ? store.entries.filter((e) => e.project.toLowerCase() === String(flags.project).toLowerCase())
            : store.entries;
          if (!pool.length) throw new NotFoundError("nothing to resume yet");
          source = pool.reduce((a, b) => (a.start > b.start ? a : b));
        }
        if (flags.switch) for (const e of store.entries.filter(isRunning)) closeEntry(e, at);
        const fresh = makeEntry({
          project: source.project,
          task: source.task,
          tags: source.tags,
          start: at,
          notes: "",
          agent: source.agent,
          agents: source.agents ?? 1,
          rate: source.rate,
          billable: source.billable,
          meta: source.meta,
        });
        store.entries.push(fresh);
        return fresh;
      }, { file });
      const row = serialize(entry);
      if (flags.json) return emitJson({ started: row });
      if (!flags.quiet) emit(`${paint("green", "resumed")} ${row.project}${row.task ? ` — ${row.task}` : ""}  ${paint("dim", row.id)}`);
    },
  },
  {
    name: "note",
    args: "<text…>",
    summary: "append a note to a running clock",
    booleans: [],
    values: ["id"],
    run({ positional, flags, file }) {
      const text = positional.join(" ").trim();
      if (!text) throw new UsageError("what note? e.g. timer note waiting on API keys");
      const entry = update((store) => {
        let target;
        if (flags.id) {
          target = findById(store.entries, flags.id);
          if (!target) throw new NotFoundError(`no entry with id "${flags.id}"`);
        } else {
          const live = store.entries.filter(isRunning);
          if (!live.length) throw new NotFoundError("no clock is running — pass --id to note a stopped entry");
          target = live.reduce((a, b) => (a.start > b.start ? a : b));
        }
        target.notes = target.notes ? `${target.notes}\n${text}` : text;
        return target;
      }, { file });
      if (flags.json) return emitJson({ noted: serialize(entry) });
      if (!flags.quiet) emit(`${paint("green", "noted")} ${paint("dim", entry.id)}`);
    },
  },
  {
    name: "report",
    aliases: ["summary", "sum"],
    summary: "totals, grouped",
    booleans: SELECT_BOOLEANS,
    values: [...SELECT_VALUES, "group"],
    multi: SELECT_MULTI,
    detail: [
      `--group takes ${GROUP_KEYS.join(", ")} (default project).`,
      "",
      "  timer report --week --group day",
      "  timer report --project acme --month --json",
    ],
    run({ positional, flags, file }) {
      const store = read(file);
      if (positional[0] && !flags.project) flags.project = positional[0];
      const group = flags.group || "project";
      const rows = selectionFrom(flags, store.entries);
      let buckets;
      try { buckets = summarize(rows, { group }); } catch (err) { throw new UsageError(err.message); }
      const t = totals(rows);
      const shaped = buckets.map((b) => ({
        key: b.key,
        entries: b.entries,
        running: b.running,
        seconds: b.seconds,
        hours: hours(b.seconds),
        billableSeconds: b.billableSeconds,
        billableHours: hours(b.billableSeconds),
      }));
      if (flags.json) {
        return emitJson({
          group,
          rows: shaped,
          totals: { ...t, hours: hours(t.seconds), billableHours: hours(t.billableSeconds) },
        });
      }
      if (!shaped.length) { if (!flags.quiet) warn("no entries match"); return; }
      emit(table(shaped, [
        { header: group.toUpperCase(), get: (r) => r.key },
        { header: "ENTRIES", get: (r) => r.entries, align: "right" },
        { header: "TIME", get: (r) => formatDuration(r.seconds), align: "right" },
        { header: "HOURS", get: (r) => r.hours.toFixed(2), align: "right" },
        { header: "BILLABLE", get: (r) => r.billableHours.toFixed(2), align: "right" },
      ]));
      emit("");
      emit(`${paint("bold", formatDuration(t.seconds))}  ${paint("dim", `${hours(t.seconds)}h total · ${hours(t.billableSeconds)}h billable`)}`);
    },
  },
  {
    name: "projects",
    summary: "projects seen, with totals",
    booleans: SELECT_BOOLEANS,
    values: SELECT_VALUES,
    multi: SELECT_MULTI,
    run({ flags, file }) {
      const store = read(file);
      const rows = selectionFrom(flags, store.entries);
      const buckets = summarize(rows, { group: "project" }).map((b) => {
        const mine = rows.filter((e) => e.project === b.key);
        const last = mine.reduce((a, e) => (a && a.start > e.start ? a : e), null);
        return {
          project: b.key,
          entries: b.entries,
          running: b.running,
          seconds: b.seconds,
          hours: hours(b.seconds),
          billableHours: hours(b.billableSeconds),
          lastSeen: last ? last.start : null,
        };
      });
      if (flags.json) return emitJson({ projects: buckets });
      if (!buckets.length) { if (!flags.quiet) warn("no projects yet — timer start <project>"); return; }
      emit(table(buckets, [
        { header: "PROJECT", get: (r) => r.project },
        { header: "ENTRIES", get: (r) => r.entries, align: "right" },
        { header: "HOURS", get: (r) => r.hours.toFixed(2), align: "right" },
        { header: "BILLABLE", get: (r) => r.billableHours.toFixed(2), align: "right" },
        { header: "LAST", get: (r) => (r.lastSeen ? shortStamp(r.lastSeen) : "-") },
        { header: "", get: (r) => (r.running ? "running" : "") },
      ]));
    },
  },
  {
    name: "export",
    summary: "dump entries as json, ndjson or csv",
    booleans: SELECT_BOOLEANS,
    values: [...SELECT_VALUES, "format", "out"],
    multi: SELECT_MULTI,
    detail: [
      "Default format is json. --out writes to a file instead of stdout, which is",
      "the one case where a --json run prints a status line (to stderr).",
    ],
    run({ flags, file }) {
      const store = read(file);
      const rows = selectionFrom(flags, store.entries).map((e) => serialize(e));
      rows.sort((a, b) => (a.start < b.start ? -1 : 1));
      const format = (flags.format || "json").toLowerCase();
      let text;
      if (format === "json") text = JSON.stringify({ entries: rows, totals: sumOf(rows) }, null, 2);
      else if (format === "ndjson") text = rows.map((r) => JSON.stringify(r)).join("\n");
      else if (format === "csv") {
        text = csv(rows, [
          { header: "id", get: (r) => r.id },
          { header: "project", get: (r) => r.project },
          { header: "task", get: (r) => r.task },
          { header: "tags", get: (r) => r.tags.join(" ") },
          { header: "start", get: (r) => r.start },
          { header: "end", get: (r) => r.end || "" },
          { header: "hours", get: (r) => r.hours },
          { header: "billable", get: (r) => (r.billable ? "yes" : "no") },
          { header: "rate", get: (r) => (r.rate == null ? "" : r.rate) },
          { header: "agent", get: (r) => r.agent || "" },
          { header: "notes", get: (r) => r.notes },
        ]);
      } else throw new UsageError(`--format: unknown format "${flags.format}" (json, ndjson, csv)`);

      if (flags.out) {
        fs.writeFileSync(flags.out, `${text}\n`);
        if (!flags.quiet) warn(`wrote ${rows.length} entries to ${flags.out}`);
        return;
      }
      emit(text);
    },
  },
  {
    name: "config",
    aliases: ["where", "paths"],
    summary: "where the timesheet lives",
    booleans: [],
    values: [],
    run({ flags, file }) {
      const exists = fs.existsSync(file);
      const store = exists ? read(file) : { entries: [] };
      if (flags.json) {
        return emitJson({ dataFile: file, home: timerHome(), exists, entries: store.entries.length, version: VERSION });
      }
      emit(`timer      ${VERSION}`);
      emit(`data file  ${file}${exists ? "" : paint("dim", "  (not created yet)")}`);
      emit(`home       ${timerHome()}`);
      emit(`entries    ${store.entries.length}`);
      emit("");
      emit(paint("dim", "override with TIMER_DATA (a file) or TIMER_HOME / PROFULLSTACK_HOME (a directory)"));
    },
  },
];

const BY_NAME = new Map();
for (const cmd of COMMANDS) {
  BY_NAME.set(cmd.name, cmd);
  for (const alias of cmd.aliases || []) BY_NAME.set(alias, cmd);
}

export function findCommand(name) {
  return BY_NAME.get(String(name || "").toLowerCase()) || null;
}

// ---------------------------------------------------------------------------

function usage() {
  const lines = [
    paint("bold", "timer") + " — track time against projects, for people and for agents",
    "",
    "  timer <command> [args] [--json]",
    "",
  ];
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  for (const c of COMMANDS) lines.push(`  ${c.name.padEnd(width)}  ${c.summary}`);
  lines.push(
    "",
    "  timer help <command>   flags and examples for one command",
    "",
    paint("dim", "  --json on any command prints one JSON document and nothing else."),
    paint("dim", `  timesheet: ${dataFile()}`),
  );
  return lines.join("\n");
}

function commandHelp(cmd) {
  const flagList = [
    ...(cmd.booleans || []).map((f) => `--${f}`),
    ...(cmd.values || []).map((f) => `--${f} <value>`),
    ...(cmd.multi || []).map((f) => `--${f} <value>  (repeatable)`),
  ];
  const lines = [
    `${paint("bold", `timer ${cmd.name}`)} ${cmd.args || ""}`.trimEnd(),
    "",
    `  ${cmd.summary}`,
  ];
  if (cmd.aliases?.length) lines.push("", `  aliases: ${cmd.aliases.join(", ")}`);
  if (flagList.length) lines.push("", "  flags:", ...flagList.map((f) => `    ${f}`));
  if (cmd.detail?.length) lines.push("", ...cmd.detail.map((l) => (l ? `  ${l}` : "")));
  lines.push("", "  global: --json  --quiet  --data <file>  --help  --version");
  return lines.join("\n");
}

export function run(argv) {
  // The first non-flag token is the command. Parsing globals first means
  // `timer --json status` and `timer status --json` are the same command.
  const head = parseArgs(argv, {
    booleans: GLOBAL_BOOLEANS,
    values: GLOBAL_VALUES,
    aliases: GLOBAL_ALIASES,
  });
  if (head.flags.version) { emit(VERSION); return 0; }

  const name = head.positional[0];
  if (!name || name === "help") {
    const topic = name === "help" ? head.positional[1] : null;
    if (topic) {
      const cmd = findCommand(topic);
      if (!cmd) throw new UsageError(`unknown command "${topic}"`);
      emit(commandHelp(cmd));
      return 0;
    }
    emit(usage());
    return 0;
  }

  const cmd = findCommand(name);
  if (!cmd) {
    throw new UsageError(`unknown command "${name}" — try: timer help`);
  }
  if (head.flags.help) { emit(commandHelp(cmd)); return 0; }

  const parsed = parseArgs(argv.slice(argv.indexOf(name) + 1), {
    booleans: [...GLOBAL_BOOLEANS, ...(cmd.booleans || [])],
    values: [...GLOBAL_VALUES, ...(cmd.values || [])],
    multi: cmd.multi || [],
    aliases: GLOBAL_ALIASES,
  });
  if (parsed.flags.help) { emit(commandHelp(cmd)); return 0; }
  if (parsed.unknown.length) {
    throw new UsageError(`unknown flag ${parsed.unknown[0]} for "${cmd.name}" — try: timer help ${cmd.name}`);
  }
  const flags = { ...head.flags, ...parsed.flags };
  delete flags.help;
  delete flags.version;
  const file = flags.data || dataFile();
  cmd.run({ positional: parsed.positional, flags, rest: parsed.rest, file });
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  try {
    return run(argv);
  } catch (err) {
    const code = err.exitCode || 1;
    // A failed run must never put a result document on stdout: an agent that
    // parses stdout would read a success shape for a command that failed.
    if (argv.includes("--json") || argv.includes("-j")) {
      process.stderr.write(`${JSON.stringify({ error: err.message, kind: err.name || "Error" }, null, 2)}\n`);
    } else {
      warn(`${paint("red", "timer:")} ${err.message}`);
    }
    return code;
  }
}
