import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { emptyStore, newId, read, update, withLock, write } from "../src/store.mjs";
import { scratch } from "./helpers.mjs";

test("a missing timesheet reads as an empty one", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  assert.deepEqual(read(s.file), emptyStore());
});

test("a corrupt timesheet is an error, never a silent reset", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  fs.mkdirSync(s.file.replace(/[^/\\]+$/, ""), { recursive: true });
  fs.writeFileSync(s.file, "{not json");
  assert.throws(() => read(s.file), /not valid JSON/);
});

test("a timesheet from a newer schema says so instead of dropping fields", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  write({ version: 99, entries: [] }, s.file);
  fs.writeFileSync(s.file, JSON.stringify({ version: 99, entries: [] }));
  assert.throws(() => read(s.file), /newer timer/);
});

test("write is atomic and leaves no temp files behind", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  write({ entries: [{ id: "a" }] }, s.file);
  const dir = s.file.replace(/[^/\\]+$/, "");
  assert.deepEqual(fs.readdirSync(dir), ["timesheet.json"]);
  assert.equal(read(s.file).entries.length, 1);
});

test("update round-trips through the lock and releases it", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const got = update((store) => {
    store.entries.push({ id: "x" });
    return "returned";
  }, { file: s.file });
  assert.equal(got, "returned");
  assert.equal(read(s.file).entries.length, 1);
  assert.equal(fs.existsSync(`${s.file}.lock`), false, "the lock is gone once the write finishes");
});

test("the lock is released even when the mutation throws", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  assert.throws(() => update(() => { throw new Error("boom"); }, { file: s.file }), /boom/);
  assert.equal(fs.existsSync(`${s.file}.lock`), false);
});

test("a held lock blocks a second writer rather than interleaving", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  withLock(() => {
    assert.throws(
      () => withLock(() => {}, { file: s.file, timeoutMs: 60 }),
      /holding/,
      "the second writer waits, then says who is holding it",
    );
  }, { file: s.file });
});

test("a stale lock is reclaimed instead of wedging the timesheet forever", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  fs.mkdirSync(`${s.file}.lock`, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${s.file}.lock`, old, old);
  const ran = withLock(() => true, { file: s.file, timeoutMs: 200, staleMs: 1000 });
  assert.equal(ran, true);
});

test("ids avoid the characters that get misread", () => {
  const ids = Array.from({ length: 200 }, () => newId());
  assert.equal(new Set(ids).size, 200, "ids do not collide in a small sample");
  for (const id of ids) assert.match(id, /^[0-9a-hj-km-np-tv-z]{8}$/);
});
