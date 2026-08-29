// Reading and writing the timesheet.
//
// Two things matter here and nothing else does:
//
//   1. A write must never leave a truncated file. Agents run this in the
//      middle of other work and a half-written timesheet loses real hours,
//      so every write is tmp-file + rename (atomic on all three platforms —
//      Node's fs.rename maps to MoveFileEx/MOVEFILE_REPLACE_EXISTING on
//      Windows, so it overwrites there like it does on POSIX).
//
//   2. Two processes must not interleave a read-modify-write. That is not
//      hypothetical: the whole point of the agent story is several sessions
//      clocking in at once. mkdir is the atomic primitive available on every
//      filesystem we care about, so the lock is a directory.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { dataFile } from "./paths.mjs";

export const SCHEMA_VERSION = 1;

/** A fresh, empty timesheet. */
export function emptyStore() {
  return { version: SCHEMA_VERSION, entries: [] };
}

/**
 * A short, URL-safe, human-typeable id.
 *
 * Base32 without the letters that get misread aloud or in a terminal font
 * (i, l, o, u), because these ids end up in `timer stop --id ...` typed by
 * hand and in invoice line items read by a client.
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export function newId(len = 8) {
  const bytes = randomBytes(len);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

/**
 * Read the timesheet, tolerating every "not there yet" case.
 *
 * A missing file is an empty timesheet, not an error: `timer status` on a
 * fresh machine should say "nothing running", not crash. A *corrupt* file is
 * a different matter and does throw — silently starting over would discard
 * someone's billable hours.
 */
export function read(file = dataFile()) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return emptyStore();
    throw err;
  }
  if (!raw.trim()) return emptyStore();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `timesheet at ${file} is not valid JSON. Move it aside to start fresh — it has not been touched.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error(`timesheet at ${file} is missing its entries array`);
  }
  if (parsed.version > SCHEMA_VERSION) {
    throw new Error(
      `timesheet at ${file} was written by a newer timer (schema ${parsed.version}); upgrade with: npm install -g @profullstack/timer`,
    );
  }
  return { version: SCHEMA_VERSION, ...parsed, entries: parsed.entries };
}

export function write(store, file = dataFile()) {
  ensureDir(file);
  const tmp = `${file}.${process.pid}.${newId(4)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...store, version: SCHEMA_VERSION }, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Hold an exclusive lock for the duration of fn.
 *
 * Stale locks are reclaimed after `staleMs` because the alternative is a
 * killed agent wedging the timesheet for everyone until someone finds the
 * directory by hand. Ten seconds is far longer than any operation here takes
 * and far shorter than a human's patience.
 */
export function withLock(fn, { file = dataFile(), timeoutMs = 5000, staleMs = 10_000 } = {}) {
  const lock = `${file}.lock`;
  ensureDir(file);
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // vanished between the mkdir and the stat — try again
      }
      if (age > staleMs) {
        try {
          fs.rmSync(lock, { recursive: true, force: true });
        } catch { /* someone else won the race; the next mkdir decides */ }
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `another timer process is holding ${lock}. If nothing else is running, remove that directory.`,
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lock, { recursive: true, force: true });
    } catch { /* best effort — a stale lock is reclaimed above */ }
  }
}

/** read → mutate → write, under the lock. Returns whatever fn returns. */
export function update(fn, { file = dataFile() } = {}) {
  return withLock(() => {
    const store = read(file);
    const result = fn(store);
    write(store, file);
    return result;
  }, { file });
}
