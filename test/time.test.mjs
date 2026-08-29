import assert from "node:assert/strict";
import test from "node:test";

import { formatDuration, hours, localDay, parseDuration, parseMoment, resolveWindow } from "../src/time.mjs";

test("parseDuration reads the spellings people type", () => {
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("1h 30m"), 5400);
  assert.equal(parseDuration("1.5h"), 5400);
  assert.equal(parseDuration("90m"), 5400);
  assert.equal(parseDuration("90"), 5400, "a bare number is minutes");
  assert.equal(parseDuration("45s"), 45);
  assert.equal(parseDuration("2d"), 172800);
});

test("parseDuration rejects what is not a duration", () => {
  for (const bad of ["", "abc", "1x", "1h30", "h", "-5m", null]) {
    assert.equal(parseDuration(bad), null, `${bad} should not parse`);
  }
});

test("formatDuration stays readable and drops noise seconds", () => {
  assert.equal(formatDuration(5400), "1h 30m");
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(3661), "1h 1m", "seconds are noise once there are hours");
});

test("hours rounds to invoice precision", () => {
  assert.equal(hours(5400), 1.5);
  assert.equal(hours(5430), 1.51);
});

test("parseMoment understands relative, clock and date forms", () => {
  const now = new Date("2026-08-29T15:00:00.000Z");
  assert.equal(parseMoment("now", { now }), now.toISOString());
  assert.equal(parseMoment("-90m", { now }), "2026-08-29T13:30:00.000Z");
  assert.equal(parseMoment("nonsense", { now }), null);
  // A bare date must be local midnight, not UTC midnight: parsing it as UTC
  // shifts a whole day of entries for anyone west of Greenwich.
  const local = parseMoment("2026-08-01", { now });
  assert.equal(localDay(local), "2026-08-01");
});

test("resolveWindow starts the week on Monday", () => {
  const now = new Date("2026-08-29T12:00:00.000Z"); // a Saturday
  const { since } = resolveWindow({ week: true }, { now });
  assert.equal(localDay(since), "2026-08-24");
});

test("resolveWindow names the flag that failed", () => {
  assert.throws(() => resolveWindow({ since: "not-a-date" }), /--since/);
});
