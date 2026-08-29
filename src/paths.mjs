// Where the timesheet lives, on every platform.
//
// One path on all three OSes rather than the usual per-platform data dir
// (%APPDATA%, ~/Library/Application Support, $XDG_DATA_HOME). That is a
// deliberate trade: this file is a published contract. `billing --from-timer`
// reads it, agents read it, and a human is expected to be able to `cat` it
// while debugging. One documented location is worth more here than OS
// convention, and homedir() is well defined on Windows too.
import { homedir } from "node:os";
import path from "node:path";

/** The shared parent for every Profullstack CLI's state. */
export function profullstackHome() {
  return process.env.PROFULLSTACK_HOME || path.join(homedir(), ".profullstack");
}

/** The directory this CLI owns. */
export function timerHome() {
  return process.env.TIMER_HOME || path.join(profullstackHome(), "timer");
}

/**
 * The timesheet file itself.
 *
 * TIMER_DATA points at a *file*, not a directory, so a test (or an agent
 * wanting a scratch timesheet) can redirect the whole store with one variable
 * and no mkdir dance.
 */
export function dataFile() {
  return process.env.TIMER_DATA || path.join(timerHome(), "timesheet.json");
}
