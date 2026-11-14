// With COVERAGE=1, every event type emitted goes to .coverage/ws-emitted.txt
// (a coverage script checks that every documented event leaves the server).
// One line per type, appended: with `bun test --parallel` several processes write to the same file.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE = join(import.meta.dir, "../../../../.coverage/ws-emitted.txt");
const seen = new Set<string>();

export function recordEmitted(type: string): void {
  if (process.env.COVERAGE !== "1" || seen.has(type)) return;
  seen.add(type);
  mkdirSync(dirname(FILE), { recursive: true });
  appendFileSync(FILE, `${type}\n`);
}
