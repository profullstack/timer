// The domain: what an entry is and the operations on a list of them.
//
// Pure functions over a plain array, deliberately. The store owns the file and
// the lock; the CLI owns argv and printing; this owns the rules. That split is
// what lets `billing --from-timer` reuse the selection logic without importing
// a command.
import { newId } from "./store.mjs";
import { localDay, parseDuration } from "./time.mjs";

/**
 * A time entry.
 *
 * `end: null` is the running clock — there is no separate "running" record, so
 * a crash mid-session leaves a recoverable open entry rather than a lost one.
 * `agent` and `meta` exist because the second audience for this tool is a
 * coding agent: it should be able to say which model logged the hours and hang
 * its own identifiers off the entry without a schema change.
 */
export function makeEntry({
  project,
  task = "",
  tags = [],
  start,
  end = null,
  notes = "",
  agent = null,
  rate = null,
  billable = true,
  meta = {},
}) {
  if (!project) throw new Error("an entry needs a project");
  return {
    id: newId(),
    project: String(project),
    task: String(task || ""),
    tags: [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))],
    start,
    end,
    notes: String(notes || ""),
    agent: agent ? String(agent) : null,
    rate: rate == null ? null : Number(rate),
    billable: Boolean(billable),
    meta: meta && typeof meta === "object" ? meta : {},
  };
}

export const isRunning = (e) => !e.end;

/** Seconds on the clock, counting a running entry up to `now`. */
export function seconds(entry, now = new Date()) {
  const start = new Date(entry.start).getTime();
  const end = entry.end ? new Date(entry.end).getTime() : now.getTime();
  return Math.max(0, Math.round((end - start) / 1000));
}

export function running(entries) {
  return entries.filter(isRunning);
}

/**
 * Resolve an id the way git resolves a sha: an unambiguous prefix is enough.
 * Throws on ambiguity rather than picking one, because the wrong pick here
 * edits somebody's billable hours.
 */
export function findById(entries, id) {
  const want = String(id).toLowerCase();
  const exact = entries.find((e) => e.id === want);
  if (exact) return exact;
  const hits = entries.filter((e) => e.id.startsWith(want));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(`id "${id}" is ambiguous (${hits.map((e) => e.id).join(", ")})`);
  }
  return null;
}

/**
 * Every filter the commands share, in one place.
 *
 * A window bound compares against the entry's *start*, and `until` is
 * exclusive. An entry that spans the boundary therefore belongs to the day it
 * began on — which is the same rule a timesheet uses, and the only one that
 * keeps a total from being counted twice.
 */
export function select(entries, {
  project,
  projects,
  task,
  tag,
  tags,
  agent,
  since,
  until,
  billable,
  ids,
  runningOnly,
  finishedOnly,
} = {}) {
  const wantProjects = [projects, project].flat().filter(Boolean).map((p) => String(p).toLowerCase());
  const wantTags = [tags, tag].flat().filter(Boolean).map((t) => String(t).toLowerCase());
  const idSet = ids ? new Set(ids.map(String)) : null;
  return entries.filter((e) => {
    if (idSet && !idSet.has(e.id)) return false;
    if (wantProjects.length && !wantProjects.includes(e.project.toLowerCase())) return false;
    if (task && !e.task.toLowerCase().includes(String(task).toLowerCase())) return false;
    if (wantTags.length && !e.tags.some((t) => wantTags.includes(t.toLowerCase()))) return false;
    if (agent && String(e.agent || "").toLowerCase() !== String(agent).toLowerCase()) return false;
    if (billable === true && !e.billable) return false;
    if (billable === false && e.billable) return false;
    if (runningOnly && !isRunning(e)) return false;
    if (finishedOnly && isRunning(e)) return false;
    if (since && e.start < since) return false;
    if (until && e.start >= until) return false;
    return true;
  });
}

const GROUPERS = {
  project: (e) => e.project,
  task: (e) => e.task || "(no task)",
  tag: (e) => (e.tags.length ? e.tags[0] : "(untagged)"),
  day: (e) => localDay(e.start),
  agent: (e) => e.agent || "(human)",
  none: () => "total",
};

export const GROUP_KEYS = Object.keys(GROUPERS);

/**
 * Totals by group, biggest first.
 *
 * `billableSeconds` is tracked alongside the total because "how long did this
 * take" and "what can I charge for it" are different questions and a report
 * that answers only one of them sends you back to the raw log.
 */
export function summarize(entries, { group = "project", now = new Date() } = {}) {
  const keyOf = GROUPERS[group];
  if (!keyOf) throw new Error(`unknown grouping "${group}" (${GROUP_KEYS.join(", ")})`);
  const buckets = new Map();
  for (const e of entries) {
    const key = keyOf(e);
    const secs = seconds(e, now);
    const bucket = buckets.get(key) || { key, seconds: 0, billableSeconds: 0, entries: 0, running: 0 };
    bucket.seconds += secs;
    if (e.billable) bucket.billableSeconds += secs;
    bucket.entries += 1;
    if (isRunning(e)) bucket.running += 1;
    buckets.set(key, bucket);
  }
  const rows = [...buckets.values()];
  // Day groupings read as a chronology; everything else reads as a ranking.
  if (group === "day") rows.sort((a, b) => a.key.localeCompare(b.key));
  else rows.sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));
  return rows;
}

export function totals(entries, now = new Date()) {
  let total = 0;
  let billable = 0;
  for (const e of entries) {
    const s = seconds(e, now);
    total += s;
    if (e.billable) billable += s;
  }
  return { seconds: total, billableSeconds: billable, entries: entries.length };
}

/**
 * Close an entry. `at` defaults to now; an explicit `at` before the start is
 * refused rather than clamped, because a negative session is a typo and
 * silently turning it into zero hides it.
 */
export function closeEntry(entry, at = new Date().toISOString()) {
  if (!isRunning(entry)) throw new Error(`entry ${entry.id} is already stopped`);
  if (at < entry.start) {
    throw new Error(`cannot stop entry ${entry.id} at ${at}: it started later, at ${entry.start}`);
  }
  entry.end = at;
  return entry;
}

/** `--duration 90m` on a manual entry, resolved against whichever bound is known. */
export function boundsFromDuration({ start, end, duration, now = new Date() }) {
  const secs = duration == null ? null : parseDuration(duration);
  if (duration != null && secs == null) throw new Error(`cannot read "${duration}" as a duration`);
  if (start && end) return { start, end };
  if (start && secs != null) return { start, end: new Date(new Date(start).getTime() + secs * 1000).toISOString() };
  if (end && secs != null) return { start: new Date(new Date(end).getTime() - secs * 1000).toISOString(), end };
  if (secs != null) {
    const endIso = now.toISOString();
    return { start: new Date(now.getTime() - secs * 1000).toISOString(), end: endIso };
  }
  return { start, end };
}
