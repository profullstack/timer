import assert from "node:assert/strict";
import test from "node:test";

import {
  boundsFromDuration,
  closeEntry,
  findById,
  makeEntry,
  seconds,
  select,
  summarize,
  totals,
} from "../src/entries.mjs";

const entry = (over = {}) => makeEntry({
  project: "acme",
  start: "2026-08-29T09:00:00.000Z",
  end: "2026-08-29T10:00:00.000Z",
  ...over,
});

test("an entry without a project is refused", () => {
  assert.throws(() => makeEntry({ project: "", start: "2026-08-29T09:00:00.000Z" }), /needs a project/);
});

test("tags are de-duplicated and trimmed", () => {
  const e = entry({ tags: [" dev ", "dev", "", "api"] });
  assert.deepEqual(e.tags, ["dev", "api"]);
});

test("a running entry counts up to now", () => {
  const e = entry({ end: null, start: "2026-08-29T09:00:00.000Z" });
  assert.equal(seconds(e, new Date("2026-08-29T09:30:00.000Z")), 1800);
});

test("findById accepts an unambiguous prefix and refuses an ambiguous one", () => {
  const a = entry(); a.id = "abcd1234";
  const b = entry(); b.id = "abcd9999";
  const c = entry(); c.id = "ffff0000";
  assert.equal(findById([a, b, c], "ffff")?.id, "ffff0000");
  assert.equal(findById([a, b, c], "nope"), null);
  assert.throws(() => findById([a, b, c], "abcd"), /ambiguous/);
});

test("stopping before the start is an error, not a zero-length entry", () => {
  const e = entry({ end: null });
  assert.throws(() => closeEntry(e, "2026-08-29T08:00:00.000Z"), /started later/);
  assert.equal(e.end, null, "the entry is left alone when the stop is refused");
});

test("stopping twice is an error", () => {
  const e = entry();
  assert.throws(() => closeEntry(e), /already stopped/);
});

test("select windows on the entry start, with an exclusive upper bound", () => {
  const early = entry({ start: "2026-08-28T23:30:00.000Z", end: "2026-08-29T00:30:00.000Z" });
  const inside = entry({ start: "2026-08-29T09:00:00.000Z" });
  const late = entry({ start: "2026-08-30T00:00:00.000Z", end: null });
  const picked = select([early, inside, late], {
    since: "2026-08-29T00:00:00.000Z",
    until: "2026-08-30T00:00:00.000Z",
  });
  assert.deepEqual(picked.map((e) => e.start), [inside.start]);
});

test("select filters on project, tag, agent and billability", () => {
  const a = entry({ project: "acme", tags: ["dev"], agent: "claude" });
  const b = entry({ project: "other", tags: ["ops"], billable: false });
  assert.equal(select([a, b], { project: "ACME" }).length, 1, "project match is case-insensitive");
  assert.equal(select([a, b], { tag: "ops" }).length, 1);
  assert.equal(select([a, b], { agent: "claude" }).length, 1);
  assert.equal(select([a, b], { billable: true }).length, 1);
  assert.equal(select([a, b], { billable: false }).length, 1);
});

test("summarize keeps billable time apart from total time", () => {
  const rows = summarize([
    entry({ project: "acme" }),
    entry({ project: "acme", billable: false }),
  ], { group: "project" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seconds, 7200);
  assert.equal(rows[0].billableSeconds, 3600);
});

test("summarize orders days chronologically and everything else by size", () => {
  const rows = summarize([
    entry({ project: "small", start: "2026-08-29T09:00:00.000Z", end: "2026-08-29T09:30:00.000Z" }),
    entry({ project: "big" }),
  ], { group: "project" });
  assert.deepEqual(rows.map((r) => r.key), ["big", "small"]);

  const days = summarize([
    entry({ start: "2026-08-29T09:00:00.000Z", end: "2026-08-29T18:00:00.000Z" }),
    entry({ start: "2026-08-28T09:00:00.000Z", end: "2026-08-28T10:00:00.000Z" }),
  ], { group: "day" });
  assert.deepEqual(days.map((r) => r.key), ["2026-08-28", "2026-08-29"]);
});

test("summarize rejects a grouping it does not have", () => {
  assert.throws(() => summarize([], { group: "colour" }), /unknown grouping/);
});

test("totals counts entries, time and billable time", () => {
  const t = totals([entry(), entry({ billable: false })]);
  assert.deepEqual(t, { seconds: 7200, billableSeconds: 3600, entries: 2 });
});

test("boundsFromDuration resolves against whichever bound is known", () => {
  const now = new Date("2026-08-29T12:00:00.000Z");
  assert.deepEqual(boundsFromDuration({ duration: "1h", now }), {
    start: "2026-08-29T11:00:00.000Z",
    end: "2026-08-29T12:00:00.000Z",
  });
  assert.equal(boundsFromDuration({ start: "2026-08-29T09:00:00.000Z", duration: "30m", now }).end,
    "2026-08-29T09:30:00.000Z");
  assert.equal(boundsFromDuration({ end: "2026-08-29T09:00:00.000Z", duration: "30m", now }).start,
    "2026-08-29T08:30:00.000Z");
  assert.throws(() => boundsFromDuration({ duration: "banana", now }), /cannot read/);
});
