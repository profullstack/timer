import assert from "node:assert/strict";
import test from "node:test";

import { cli, json, scratch } from "./helpers.mjs";

test("start then stop records a session", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const started = json(["start", "acme", "fix", "the", "login"], { file: s.file });
  assert.equal(started.code, 0);
  assert.equal(started.data.started.project, "acme");
  assert.equal(started.data.started.task, "fix the login", "trailing words become the task");
  assert.equal(started.data.started.running, true);

  const stopped = json(["stop"], { file: s.file });
  assert.equal(stopped.code, 0);
  assert.equal(stopped.data.stopped.length, 1);
  assert.equal(stopped.data.stopped[0].running, false);
  assert.equal(stopped.data.stopped[0].id, started.data.started.id);
});

test("stopping with nothing running succeeds — it is an answer, not a failure", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const res = json(["stop"], { file: s.file });
  assert.equal(res.code, 0);
  assert.deepEqual(res.data.stopped, []);
});

test("several clocks run at once, and --switch closes the others", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  json(["start", "one"], { file: s.file });
  const second = json(["start", "two"], { file: s.file });
  assert.equal(second.data.alsoRunning.length, 1, "the other clock keeps running by default");

  const third = json(["start", "three", "--switch"], { file: s.file });
  assert.equal(third.data.stopped.length, 2);
  assert.equal(json(["status"], { file: s.file }).data.running.length, 1);
});

test("stop targets the newest clock, an id, a project, or all of them", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const a = json(["start", "alpha", "--at", "-3h"], { file: s.file }).data.started;
  const b = json(["start", "beta", "--at", "-2h"], { file: s.file }).data.started;
  json(["start", "gamma", "--at", "-1h"], { file: s.file });

  const newest = json(["stop"], { file: s.file });
  assert.equal(newest.data.stopped[0].project, "gamma");

  const byId = json(["stop", a.id.slice(0, 4)], { file: s.file });
  assert.equal(byId.data.stopped[0].id, a.id, "an unambiguous id prefix is enough");

  const rest = json(["stop", "--all"], { file: s.file });
  assert.deepEqual(rest.data.stopped.map((e) => e.id), [b.id]);
});

test("add records time two of --from/--to/--duration describe", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const byDuration = json(["add", "acme", "code", "review", "--duration", "45m"], { file: s.file });
  assert.equal(byDuration.data.added.hours, 0.75);

  const byRange = json(["add", "acme", "--from", "2026-08-01T09:00:00Z", "--to", "2026-08-01T11:30:00Z"], { file: s.file });
  assert.equal(byRange.data.added.hours, 2.5);
});

test("add refuses an under-specified or backwards range", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  assert.equal(cli(["add", "acme", "--from", "09:00"], { file: s.file }).code, 2);
  const backwards = cli(["add", "acme", "--from", "2026-08-01T11:00:00Z", "--to", "2026-08-01T09:00:00Z"], { file: s.file });
  assert.equal(backwards.code, 2);
  assert.match(backwards.stderr, /end before it started/);
});

test("--no-billable time is tracked but excluded from billable totals", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  json(["add", "acme", "--duration", "1h"], { file: s.file });
  json(["add", "acme", "standup", "--duration", "1h", "--no-billable"], { file: s.file });
  const report = json(["report"], { file: s.file });
  assert.equal(report.data.totals.hours, 2);
  assert.equal(report.data.totals.billableHours, 1);
});

test("report groups by day, project, tag and agent", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  json(["add", "acme", "--from", "2026-08-01T09:00:00Z", "--to", "2026-08-01T10:00:00Z", "--tag", "dev", "--agent", "claude"], { file: s.file });
  json(["add", "other", "--from", "2026-08-02T09:00:00Z", "--to", "2026-08-02T11:00:00Z", "--tag", "ops"], { file: s.file });

  assert.deepEqual(json(["report", "--group", "project"], { file: s.file }).data.rows.map((r) => r.key), ["other", "acme"]);
  assert.equal(json(["report", "--group", "agent"], { file: s.file }).data.rows.length, 2);
  assert.equal(json(["report", "--group", "tag"], { file: s.file }).data.rows.length, 2);
  assert.equal(cli(["report", "--group", "colour"], { file: s.file }).code, 2);
});

test("windows select on the entry start", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  json(["add", "old", "--from", "2020-01-01T09:00:00Z", "--to", "2020-01-01T10:00:00Z"], { file: s.file });
  json(["add", "new", "--duration", "30m"], { file: s.file });
  const today = json(["log", "--today"], { file: s.file });
  assert.deepEqual(today.data.entries.map((e) => e.project), ["new"]);
});

test("edit changes only the fields it is given", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const added = json(["add", "acme", "old task", "--duration", "1h", "--tag", "dev"], { file: s.file }).data.added;
  const edited = json(["edit", added.id, "--task", "new task"], { file: s.file }).data.updated;
  assert.equal(edited.task, "new task");
  assert.equal(edited.project, "acme");
  assert.deepEqual(edited.tags, ["dev"]);
  assert.equal(edited.hours, 1);
});

test("rm will not silently delete a clock that is still running", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const started = json(["start", "acme"], { file: s.file }).data.started;
  const refused = cli(["rm", started.id], { file: s.file });
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /still running/);
  assert.equal(cli(["rm", started.id, "--force"], { file: s.file }).code, 0);
  assert.equal(json(["log"], { file: s.file }).data.entries.length, 0);
});

test("resume copies the last entry onto a fresh clock", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  json(["add", "acme", "auth", "--duration", "1h", "--tag", "dev"], { file: s.file });
  const resumed = json(["resume"], { file: s.file }).data.started;
  assert.equal(resumed.project, "acme");
  assert.equal(resumed.task, "auth");
  assert.deepEqual(resumed.tags, ["dev"]);
  assert.equal(resumed.running, true);
});

test("note appends to the running clock", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  json(["start", "acme"], { file: s.file });
  json(["note", "waiting", "on", "keys"], { file: s.file });
  const noted = json(["note", "second", "line"], { file: s.file }).data.noted;
  assert.equal(noted.notes, "waiting on keys\nsecond line");
});

test("export emits json, ndjson and csv", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  json(["add", "acme", "a, with comma", "--duration", "1h"], { file: s.file });
  json(["add", "other", "b", "--duration", "30m"], { file: s.file });

  const asJson = JSON.parse(cli(["export"], { file: s.file }).stdout);
  assert.equal(asJson.entries.length, 2);

  const nd = cli(["export", "--format", "ndjson"], { file: s.file }).stdout.trim().split("\n");
  assert.equal(nd.length, 2);
  assert.equal(JSON.parse(nd[0]).project, "acme");

  const csvOut = cli(["export", "--format", "csv"], { file: s.file }).stdout.trim().split("\n");
  assert.equal(csvOut[0], "id,project,task,tags,start,end,hours,billable,rate,agent,notes");
  assert.match(csvOut[1], /"a, with comma"/, "a comma in a field is quoted");

  assert.equal(cli(["export", "--format", "xml"], { file: s.file }).code, 2);
});

test("an unknown flag fails loudly instead of being ignored", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const res = cli(["log", "--bogus"], { file: s.file });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unknown flag --bogus/);
});

test("a failed --json run writes the error to stderr and leaves stdout empty", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const res = cli(["rm", "nope", "--json"], { file: s.file });
  assert.equal(res.code, 3, "not-found has its own exit code");
  assert.equal(res.stdout, "", "an agent parsing stdout must not see a success shape");
  assert.equal(JSON.parse(res.stderr).kind, "NotFoundError");
});

test("--json prints exactly one JSON document and nothing else", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  json(["start", "one"], { file: s.file });
  const res = cli(["start", "two", "--json"], { file: s.file });
  assert.doesNotThrow(() => JSON.parse(res.stdout), "the advisory about the other clock went to stderr");
});

test("TIMER_AGENT stamps entries an agent created", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const res = json(["add", "acme", "--duration", "1h"], { file: s.file, env: { TIMER_AGENT: "claude-opus-5" } });
  assert.equal(res.data.added.agent, "claude-opus-5");
});

test("--meta carries an agent's own identifiers through unchanged", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const res = json(["add", "acme", "--duration", "1h", "--meta", '{"issue":"PR-42"}'], { file: s.file });
  assert.deepEqual(res.data.added.meta, { issue: "PR-42" });
  assert.equal(cli(["add", "acme", "--duration", "1h", "--meta", "nope"], { file: s.file }).code, 2);
});

test("help and version answer without touching the timesheet", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  assert.match(cli(["--version"], { file: s.file }).stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.match(cli([], { file: s.file }).stdout, /timer <command>/);
  assert.match(cli(["help", "start"], { file: s.file }).stdout, /--switch/);
  assert.equal(cli(["help", "nonesuch"], { file: s.file }).code, 2);
  assert.equal(cli(["nonesuch"], { file: s.file }).code, 2);
});

test("config reports where the timesheet lives", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const res = json(["config"], { file: s.file });
  assert.equal(res.data.dataFile, s.file);
  assert.equal(res.data.exists, false);
});
