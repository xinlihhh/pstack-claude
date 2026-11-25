#!/usr/bin/env bun
// Stands in for the `paseo` CLI (a test links it onto PATH as `paseo`) and for
// the Pi child behind each agent. It keeps its state in $FAKE_PASEO_DIR: every
// invocation in calls.jsonl, one folder per agent, and the scenario it plays in
// script.json: { byText: { "<message>": [steps] }, default: [steps],
// oldPstack, runError, sendError, sendMs, inspect: { status } | { error } }.
//
// run and send put the message in the agent's inbox, wrapped as Paseo wraps a
// message from an agent. wait is when the child works: it takes the next
// message, writes its Pi session as the pstack child does (with the real
// unwrap), and plays the steps for the message's text.
//
// Steps: { reply } an assistant message ("${text}" is the message, "${steer}"
// the last steered one); { failed } an assistant message that ended in an
// error; { follow } a user message typed in Paseo that aborts nothing;
// { sleep } waits that many ms; { toolUse } a tool call and its result; { awaitSteer } waits for a
// send and records its input entry, as Pi does on a steer; { takeSteer } adds
// that steered message; { awaitSend } waits for a send without reading it;
// { idle } answers idle now and goes on at the next wait; { typed } the user
// types in Paseo, which aborts the turn; { stopped } the user presses stop;
// { hang } works until the agent is archived; { permission } and { error }
// answer wait with that status.
//
// As the daemon does, archive ends the waits in flight on the agent, and a wait
// that outlives it reads the agent's timeline, which loads an archived agent
// again. That read is logged as "timeline".
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { INPUT_ENTRY, unwrapMessages } from "../../plugins/pstack/pi/paseo-child.ts";

const root = process.env.FAKE_PASEO_DIR;
const [command, ...rest] = process.argv.slice(2);
const separator = rest.indexOf("--");
const flags = separator === -1 ? rest : rest.slice(0, separator);
const message = separator === -1 ? undefined : rest[separator + 1];
const caller = process.env.PASEO_AGENT_ID ?? null;
const script = existsSync(join(root, "script.json")) ? JSON.parse(readFileSync(join(root, "script.json"), "utf8")) : {};
const log = (record) => appendFileSync(join(root, "calls.jsonl"), `${JSON.stringify(record)}\n`);
log({ command, argv: rest, caller, at: Date.now() });

const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const fail = (code, text) => {
  process.stderr.write(`${JSON.stringify({ error: { code, message: text } }, null, 2)}\n`);
  process.exit(1);
};
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const dirOf = (id) => join(root, "agents", id);
const archivedFile = (id) => join(dirOf(id), "archived");
const waitsDir = (id) => join(dirOf(id), "waits");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const known = (id) => {
  if (!existsSync(dirOf(id))) fail("AGENT_NOT_FOUND", `Agent not found: ${id}`);
  return id;
};
const escapeXml = (text) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const envelope = (text) =>
  `<paseo-system version="1" kind="agent-message" source-agent-id="${caller}" message-id="${randomUUID()}" source-agent-title="the &quot;parent&quot; &amp; co">\n${escapeXml(text)}\n</paseo-system>`;
const deliver = (id) => appendFileSync(join(dirOf(id), "inbox.jsonl"), `${JSON.stringify(envelope(message))}\n`);

if (command === "run") {
  if (script.runError) fail(script.runError, "the daemon said no");
  const env = {};
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] !== "--env") continue;
    const pair = flags[i + 1];
    env[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1);
  }
  const id = `pstackfake-${randomUUID()}`;
  mkdirSync(dirOf(id), { recursive: true });
  writeFileSync(join(dirOf(id), "launch.json"), JSON.stringify({ env, session: randomUUID() }));
  deliver(id);
  print({ agentId: id, status: "created" });
} else if (command === "send") {
  const id = known(flags.at(-1));
  if (script.sendMs) await Bun.sleep(script.sendMs);
  if (script.sendError) fail(script.sendError, "the daemon said no");
  const cursorFile = join(dirOf(id), "cursor.json");
  // The archive ended the turn the agent was in.
  if (existsSync(archivedFile(id)) && existsSync(cursorFile)) writeFileSync(cursorFile, JSON.stringify({ ...JSON.parse(readFileSync(cursorFile, "utf8")), steps: [] }));
  rmSync(archivedFile(id), { force: true });
  deliver(id);
  log({ command: "sent", argv: rest, at: Date.now() });
  print({ agentId: id, status: "queued" });
} else if (command === "archive") {
  const id = known(flags.at(-1));
  if (existsSync(archivedFile(id))) fail("AGENT_ALREADY_ARCHIVED", "already archived");
  writeFileSync(archivedFile(id), "");
  const waiting = () => existsSync(waitsDir(id)) && readdirSync(waitsDir(id)).some((pid) => alive(Number(pid)));
  for (const end = Date.now() + 2000; waiting() && Date.now() < end; ) await Bun.sleep(10);
  print({ agentId: id, status: "archived" });
} else if (command === "inspect") {
  if (script.inspect?.error) fail(script.inspect.error, "cannot inspect");
  const id = known(flags.at(-1));
  print({ Id: id, Status: script.inspect?.status ?? "idle", Archived: existsSync(archivedFile(id)) });
} else if (command === "wait") {
  const id = known(flags.at(-1));
  mkdirSync(waitsDir(id), { recursive: true });
  const registered = join(waitsDir(id), String(process.pid));
  writeFileSync(registered, "");
  const result = await work(id);
  if (existsSync(archivedFile(id))) log({ command: "timeline", argv: [id], at: Date.now() });
  rmSync(registered);
  print({ agentId: id, ...result });
} else fail("UNKNOWN_COMMAND", command);

async function work(id) {
  const dir = dirOf(id);
  const { env, session } = JSON.parse(readFileSync(join(dir, "launch.json"), "utf8"));
  const handoff = JSON.parse(env.PSTACK_AGENT);
  const sessionFile = join(env.PI_CODING_AGENT_SESSION_DIR, `2026-01-01T00-00-00-000Z_${session}.jsonl`);
  const cursorFile = join(dir, "cursor.json");
  const cursor = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, "utf8")) : { read: 0, steps: [], text: "", steer: "" };
  const inbox = () => lines(join(dir, "inbox.jsonl"));
  const write = (entry) => {
    if (!existsSync(sessionFile)) writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: session })}\n`);
    appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
  };
  const user = (text) => write({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
  const assistant = (content, stopReason, extra = {}) => write({ type: "message", message: { role: "assistant", content, stopReason, ...extra } });
  const say = (text, stopReason = "stop") => assistant(text ? [{ type: "text", text }] : [], stopReason);
  // As the child's input hook: the entry goes in when the message arrives.
  const receive = () => {
    const raw = inbox()[cursor.read++];
    if (script.oldPstack) return raw;
    const { text, last } = unwrapMessages(raw, handoff);
    if (last !== undefined) write({ type: "custom", customType: INPUT_ENTRY, data: { n: last } });
    return text;
  };
  const save = () => writeFileSync(cursorFile, JSON.stringify(cursor));
  const until = async (done, ms) => {
    for (const end = Date.now() + ms; !done() && Date.now() < end; ) await Bun.sleep(10);
  };

  for (;;) {
    if (existsSync(archivedFile(id))) return save(), { status: "idle" };
    if (!cursor.steps.length) {
      if (cursor.read >= inbox().length) return save(), { status: "idle" };
      cursor.text = receive();
      user(cursor.text);
      cursor.steps = script.byText?.[cursor.text] ?? script.default ?? [{ reply: "reply to: ${text}" }];
    }
    const step = cursor.steps.shift();
    const expand = (text) => text.replaceAll("${text}", () => cursor.text).replaceAll("${steer}", () => cursor.steer);
    if ("reply" in step) say(expand(step.reply));
    else if ("failed" in step) assistant([], "error", { errorMessage: step.failed });
    else if ("follow" in step) user(step.follow);
    else if (step.sleep) await Bun.sleep(step.sleep);
    else if (step.toolUse) {
      assistant([{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], "toolUse");
      write({ type: "message", message: { role: "toolResult", content: [] } });
    } else if (step.awaitSteer) {
      await until(() => cursor.read < inbox().length, step.awaitSteer);
      cursor.steer = receive();
    } else if (step.takeSteer) user(cursor.steer);
    else if (step.awaitSend) await until(() => cursor.read < inbox().length, step.awaitSend);
    else if (step.idle) return save(), { status: "idle" };
    else if (step.typed) {
      say("", "aborted");
      user(step.typed);
    } else if (step.stopped) say("", "aborted");
    else if (step.hang) await until(() => existsSync(archivedFile(id)), 60_000);
    else if (step.permission) return save(), { status: "permission" };
    else if (step.error) return save(), { status: "error", message: step.error };
    else fail("BAD_STEP", JSON.stringify(step));
    save();
  }
}
