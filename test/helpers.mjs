import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "timer.mjs");

/** A throwaway timesheet, so no test can touch a real one. */
export function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timer-test-"));
  return {
    file: path.join(dir, "timesheet.json"),
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/**
 * Run the CLI the way a user does — a real child process, so argv parsing,
 * exit codes and the stdout/stderr split are all under test rather than
 * assumed. Never throws: the exit code is the assertion.
 */
export function cli(args, { file, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: "utf8",
      env: { ...process.env, TIMER_DATA: file, NO_COLOR: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout || "", stderr: err.stderr || "" };
  }
}

export function json(args, opts) {
  const res = cli([...args, "--json"], opts);
  return { ...res, data: res.stdout.trim() ? JSON.parse(res.stdout) : null };
}
