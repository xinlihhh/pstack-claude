#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const dir = process.env.FAKE_ORCA_DIR;
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const script = existsSync(join(dir, "script.json")) ? JSON.parse(readFileSync(join(dir, "script.json"), "utf8")) : {};
const log = (record) => appendFileSync(join(dir, "pi.jsonl"), `${JSON.stringify({ pid: process.pid, ...record })}\n`);

const prompt = argv.at(-1);
const session = join(flag("--session-dir"), `2026-01-01T00-00-00-000Z_${flag("--session-id")}.jsonl`);
const append = (entry) => appendFileSync(session, `${JSON.stringify(entry)}\n`);
const write = (role, text, extra, id) => append({ type: "message", id, message: { role, content: [{ type: "text", text }], ...extra } });

const files = readdirSync(flag("--session-dir")).filter((name) => !name.endsWith(".jsonl"));
log({ argv, prompt, files, cwd: process.cwd(), env: { PSTACK_PROBE: process.env.PSTACK_PROBE, ORCA_PANE_KEY: process.env.ORCA_PANE_KEY, ORCA_PI_STATUS_OWNED: process.env.ORCA_PI_STATUS_OWNED } });
if (script.exit !== undefined) {
  if (script.stderr) process.stderr.write(script.stderr);
  process.exit(script.exit);
}

write("user", prompt);
if (script.hang) {
  write("assistant", "working", { stopReason: "toolUse" });
  log({ tool: spawn("sleep", ["30"], { stdio: "ignore" }).pid });
} else if (script.awaitSteer) {
  const inbox = join(dir, "inbox.jsonl");
  while (!existsSync(inbox)) await sleep(20);
  write("assistant", "before the steer", { stopReason: "stop" });
  // Longer than two of the parent's polls, so a settle rule that ignores the steer would end the run on the reply above.
  await sleep(1200);
  const steer = JSON.parse(readFileSync(inbox, "utf8").split("\n")[0]);
  write("user", steer);
  write("assistant", `steered: ${steer}`, { stopReason: "stop" });
} else if (script.retry) {
  // Five gaps shorter than the parent's poll, so one of its polls falls in a gap.
  for (let attempt = 1; attempt <= 5; attempt++) {
    write("assistant", "", { stopReason: "error", errorMessage: "overloaded" }, `e${attempt}`);
    await sleep(450);
    append({ type: "context_edit", id: `c${attempt}`, targetId: `e${attempt}`, replacement: null });
    await sleep(100);
  }
  write("assistant", "reply after retry", { stopReason: "stop" });
} else {
  write("assistant", `reply to ${prompt}`, { stopReason: script.stopReason ?? "stop" });
}
setInterval(() => {}, 1000);
