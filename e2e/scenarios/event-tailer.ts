/**
 * Poll-reads `events.ndjson` under an isolated SHIP home tree so operators
 * see SDK event `type` lines during long live runs.
 *
 * Extracted from `hello-world.e2e.test.ts` (Phase 9) for reuse across L4
 * scenarios. Uses byte-accurate Buffer slicing before UTF-8 decode so
 * multi-byte sequences never split at poll boundaries.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface EventTailer {
  stop(): void;
}

/**
 * Polls `tmp` recursively for any `events.ndjson` file. Once found,
 * keeps polling its size and prints each newly-appended NDJSON line's
 * `type` to stdout. Pure interval-based — no `watchFile`, so the
 * process exits cleanly when `stop()` runs (which it always does, in
 * the test's `finally`).
 *
 * Cheap: each poll is a stat + slice of the file from the last
 * position. 250ms cadence mirrors live-run human feedback.
 */
export function startEventTailer(tmp: string, _child: { kill?: () => void }): EventTailer {
  const POLL_MS = 250;
  let eventsPath: string | undefined;
  let position = 0;

  const interval = setInterval(() => {
    if (eventsPath === undefined) {
      eventsPath = findEventsNdjson(tmp);
      if (eventsPath !== undefined) {
        process.stdout.write(`[e2e] tailing ${eventsPath}\n`);
      }
      return;
    }
    let size: number;
    try {
      size = statSync(eventsPath).size;
    } catch {
      return;
    }
    if (size <= position) return;
    let chunk: string;
    try {
      const buf = readFileSync(eventsPath);
      chunk = buf.subarray(position, size).toString("utf-8");
    } catch {
      return;
    }
    position = size;
    for (const line of chunk.split("\n").filter((l) => l.length > 0)) {
      try {
        const ev = JSON.parse(line) as { type?: string };
        process.stdout.write(`[ship-event] ${ev.type ?? "?"}\n`);
      } catch {
        process.stdout.write(`[ship-event] (unparseable: ${line.slice(0, 60)}…)\n`);
      }
    }
  }, POLL_MS);

  return {
    stop: () => {
      clearInterval(interval);
    },
  };
}

/**
 * Recursively walks `root` looking for the first `events.ndjson`
 * file. Returns the absolute path if found, `undefined` otherwise.
 */
export function findEventsNdjson(root: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    const child = join(root, name);
    let isDir = false;
    try {
      isDir = statSync(child).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) {
      if (name === "events.ndjson") return child;
      continue;
    }
    const found = findEventsNdjson(child);
    if (found !== undefined) return found;
  }
  return undefined;
}
