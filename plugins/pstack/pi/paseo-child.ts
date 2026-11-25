import { execFile, type ExecFileOptions, spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import { alive, assistantText, type ChildExit } from "./child.ts";
import type { PstackHandoff } from "./config.ts";
import { jsonLines, replyOf, sizeOf } from "./hc-child.ts";

const execPaseo = promisify(execFile);
const CLI_TIMEOUT_MS = 60_000;
const INSPECT_TIMEOUT_MS = 5000;
const CLI_MAX_BUFFER = 64 * 1024 * 1024;
const PERMISSION_POLL_MS = 2000;
const REPLY_POLL_MS = 500;
const REPLY_WAIT_MS = 60_000;

export const INPUT_ENTRY = "pstack-paseo-input";
const OUTDATED = "the pstack installed in Pi is too old for pi agent host: paseo";

const runResult = Type.Object({ agentId: Type.String() });
const sendResult = Type.Object({ agentId: Type.String() });
const waitResult = Type.Object({ status: Type.String(), message: Type.Optional(Type.String()) });
const inspectResult = Type.Object({ Archived: Type.Boolean() });
const cliError = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.String() }) });
const inputEntry = Type.Object({ type: Type.Literal("custom"), customType: Type.Literal(INPUT_ENTRY), data: Type.Object({ n: Type.Number() }) });
const messageEntry = Type.Object({
  type: Type.Literal("message"),
  message: Type.Object({ role: Type.String(), content: Type.Optional(Type.Unknown()), stopReason: Type.Optional(Type.String()) }),
});

// What goes through Paseo in place of a message, which stays in a file: argv has a size limit, and Paseo escapes and trims the text.
const messageName = (n: number) => `pstack-message ${n}`;
const messageFile = (dir: string, n: number) => join(dir, `msg-${n}.md`);
// Paseo XML-escapes an envelope's body, so a < can only be the closing tag.
const ENVELOPE = /<paseo-system version="1" kind="agent-message" source-agent-id="([^"<>]*)"[^<>]*>\n([^<]*)\n<\/paseo-system>/g;

export function unwrapMessages(text: string, { parent, msgDir }: Pick<PstackHandoff, "parent" | "msgDir">): { text: string; last?: number } {
  let last: number | undefined;
  const unwrapped = text.replace(ENVELOPE, (envelope, source: string, body: string) => {
    const n = /^pstack-message (\d+)$/.exec(body)?.[1];
    if (source !== parent || n === undefined) return envelope;
    last = Math.max(last ?? 0, Number(n));
    return readFileSync(messageFile(msgDir, Number(n)), "utf8");
  });
  return { text: unwrapped, last };
}

export type PaseoReply = Pick<ChildExit, "finalText" | "errorMessage" | "interruption"> & { state: "pending" | "done" | "outdated" };

// The reply in a child's session to message `last`. Each input entry the child
// wrote stands for one user message of ours; any other user message after
// `last` was typed in Paseo, and the reply ends there.
export function paseoReply(file: string | undefined, from: number, last: number): PaseoReply {
  const entries = file ? jsonLines(readFileSync(file).subarray(from).toString("utf8")) : [];
  const turn: Static<typeof messageEntry>[] = [];
  let ours = 0;
  let marked = false;
  let reached = false;
  let echoed = false;
  let typed = false;
  for (const entry of entries) {
    if (Value.Check(inputEntry, entry)) {
      ours++;
      marked = true;
      reached ||= entry.data.n >= last;
      continue;
    }
    if (!Value.Check(messageEntry, entry)) continue;
    const { role, content, stopReason } = entry.message;
    if (role === "user") {
      const text = typeof content === "string" ? content : Array.isArray(content) ? assistantText(content) : "";
      echoed ||= text.includes(messageName(last));
      if (ours > 0) ours--;
      else if (reached) {
        typed = true;
        break;
      }
    } else if (role === "assistant") {
      if (echoed && !marked && stopReason !== "toolUse") return { state: "outdated", finalText: "", errorMessage: "" };
      if (reached) turn.push(entry);
    }
  }
  const reply = replyOf(turn);
  const end = turn.at(-1)?.message.stopReason;
  const unfinished = end === undefined || end === "toolUse";
  if (!reached || (!typed && (ours > 0 || unfinished))) return { ...reply, state: "pending" };
  const aborted = turn.some((entry) => entry.message.stopReason === "aborted");
  if (typed && (aborted || unfinished)) return { ...reply, state: "done", interruption: "interrupted by input typed in Paseo" };
  return { ...reply, state: "done", interruption: aborted ? "stopped in Paseo" : undefined };
}

export interface PaseoLaunch {
  title: string;
  model?: string;
  thinking?: string;
  cwd: string;
  label: string;
  env: Record<string, string | undefined>;
}

export interface PaseoOptions {
  // This session's Paseo agent, which becomes the child's parent.
  caller: string;
  // The agent's own folder: its message files and its Pi session.
  dir: string;
  target: PaseoLaunch | { agentId: string };
  onAgent: (agentId: string) => void;
  transcript: () => string | undefined;
}

type Phase = "running" | "ending" | "done";

export class PaseoChild {
  readonly pid = undefined;
  readonly activity = undefined;
  readonly exited: Promise<ChildExit>;
  private phase: Phase = "running";
  private agentId?: string;
  private next: number;
  // The highest message sent. settle() reads it only once every send has settled.
  private last: number;
  private readonly from: number;
  // The start and every send, in order. It never rejects.
  private sends: Promise<unknown>;
  private archived?: Promise<void>;
  private readonly stopped = new AbortController();

  constructor(
    private readonly opts: PaseoOptions,
    prompt: string,
  ) {
    this.from = sizeOf(opts.transcript());
    this.next = Math.max(-1, ...readdirSync(opts.dir).map((name) => Number(/^msg-(\d+)\.md$/.exec(name)?.[1] ?? -1))) + 1;
    this.last = this.write(prompt);
    const { target } = opts;
    const first = "agentId" in target ? this.resume(target.agentId, this.last) : this.start(target, this.last);
    this.sends = first.catch(() => undefined);
    this.exited = this.drive(first);
  }

  // Steers a running turn, and starts one on an idle agent. Never queued: Paseo
  // keeps a queued message through a stop and delivers it with the next one.
  async steer(message: string): Promise<{ response: { success: boolean; error?: string } | undefined; taken: boolean }> {
    if (this.phase !== "running") return { response: undefined, taken: false };
    const n = this.write(message);
    const sent = this.sends.then(async () => {
      await this.send(n);
      this.last = Math.max(this.last, n);
    });
    this.sends = sent.catch(() => undefined);
    try {
      await sent;
    } catch (e) {
      return { response: { success: false, error: errorText(e) }, taken: false };
    }
    return { response: { success: true }, taken: true };
  }

  // Archives, which ends the child's pi process; a stop would leave it running.
  end(): void {
    if (this.archived) return;
    this.abandonWait();
    // After the sends, since one that arrives after the archive would unarchive the agent.
    this.archived = this.sends.then(() => (this.agentId ? archivePaseoAgent(this.agentId) : undefined));
  }

  signal(): void {
    this.abandonWait();
    if (this.agentId) archivePaseoAgentDetached(this.agentId);
  }

  // Kills the wait before any archive. A wait that sees its agent archived reads its timeline, for which Paseo
  // loads the agent again, and a message sent during that load crashes the daemon (Paseo 0.17.4).
  private abandonWait(): void {
    this.phase = "ending";
    this.stopped.abort();
  }

  private write(message: string): number {
    const n = this.next++;
    writeFileSync(messageFile(this.opts.dir, n), message, { mode: 0o600 });
    return n;
  }

  private async start({ title, model, thinking, cwd, label, env }: PaseoLaunch, n: number): Promise<string> {
    const args = ["run", "--json", "--no-wait", "--provider", model ? `pi/${model}` : "pi", "--title", title, "--cwd", cwd, "--label", label];
    if (thinking) args.push("--thinking", thinking);
    for (const [name, value] of Object.entries(env)) if (value !== undefined) args.push("--env", `${name}=${value}`);
    const { agentId } = await this.paseo(runResult, [...args, "--", messageName(n)]);
    return this.adopt(agentId);
  }

  private async resume(agentId: string, n: number): Promise<string> {
    this.adopt(agentId);
    await this.send(n);
    return agentId;
  }

  private adopt(agentId: string): string {
    this.agentId = agentId;
    this.opts.onAgent(agentId);
    return agentId;
  }

  private async send(n: number): Promise<void> {
    if (!this.agentId) throw new Error("the Paseo agent did not start");
    await this.paseo(sendResult, ["send", "--json", "--behavior", "steer", "--no-wait", this.agentId, "--", messageName(n)]);
  }

  private async drive(first: Promise<string>): Promise<ChildExit> {
    const exit = (errorMessage: string): ChildExit => ({
      exitCode: null,
      settled: false,
      finalText: paseoReply(this.opts.transcript(), this.from, this.last).finalText,
      errorMessage,
      stderr: "",
    });
    try {
      const reply = await this.settle(await first);
      if (reply) {
        const { finalText, errorMessage, interruption } = reply;
        return { exitCode: 0, settled: true, finalText, errorMessage, interruption, stderr: "" };
      }
    } catch (e) {
      if (!this.ending()) {
        this.end();
        await this.archived;
        return exit(errorText(e));
      }
    }
    await this.archived;
    return exit("");
  }

  private async settle(agentId: string): Promise<PaseoReply | undefined> {
    const { signal } = this.stopped;
    let idleSince: number | undefined;
    for (;;) {
      const { sends } = this;
      await sends;
      if (this.ending()) return undefined;
      const { status, message } = await this.paseo(waitResult, ["wait", "--json", agentId], { signal, timeout: 0, killSignal: "SIGKILL" });
      if (this.ending()) return undefined;
      if (status === "error") throw new Error(message ?? "the Paseo agent failed");
      if (status === "permission") {
        await sleep(PERMISSION_POLL_MS, undefined, { signal });
        continue;
      }
      // A send made since may have started a turn the wait did not see.
      if (sends !== this.sends) {
        idleSince = undefined;
        continue;
      }
      const reply = paseoReply(this.opts.transcript(), this.from, this.last);
      if (reply.state === "outdated") throw new Error(OUTDATED);
      if (reply.state === "done") {
        this.phase = "done";
        return reply;
      }
      idleSince ??= Date.now();
      if (Date.now() - idleSince > REPLY_WAIT_MS) throw new Error("Paseo reports the agent idle, but its session has no reply to the last message.");
      await sleep(REPLY_POLL_MS, undefined, { signal });
    }
  }

  private ending(): boolean {
    return this.phase === "ending";
  }

  private async paseo<T extends TSchema>(schema: T, args: string[], options: Pick<ExecFileOptions, "signal" | "timeout" | "killSignal"> = {}): Promise<Static<T>> {
    const { stdout } = await execPaseo("paseo", args, {
      timeout: CLI_TIMEOUT_MS,
      ...options,
      maxBuffer: CLI_MAX_BUFFER,
      env: { ...process.env, PASEO_AGENT_ID: this.opts.caller },
    });
    const result: unknown = JSON.parse(stdout);
    if (!Value.Check(schema, result)) throw new Error(`paseo ${args[0]} answered: ${stdout.trim().slice(0, 300)}`);
    return result;
  }
}

export function paseoFate(agentId: string | undefined, launcher: number): "kept" | "orphan" | "unknown" | "gone" {
  if (agentId === undefined) return "gone";
  if (launcher !== process.pid && alive(launcher)) return "kept";
  const inspected = spawnSync("paseo", ["inspect", "--json", agentId], { encoding: "utf8", timeout: INSPECT_TIMEOUT_MS });
  const answer = parseJson(inspected.status === 0 ? inspected.stdout : inspected.stderr);
  if (inspected.status === 0 && Value.Check(inspectResult, answer)) return answer.Archived ? "gone" : "orphan";
  return Value.Check(cliError, answer) && answer.error.code === "AGENT_NOT_FOUND" ? "gone" : "unknown";
}

// Never rejects: a stop or a teardown goes on whatever the daemon answers.
export function archivePaseoAgent(agentId: string): Promise<void> {
  return execPaseo("paseo", ["archive", "--json", "--force", agentId], { timeout: CLI_TIMEOUT_MS }).then(
    () => undefined,
    () => undefined,
  );
}

export function archivePaseoAgentDetached(agentId: string): void {
  spawn("paseo", ["archive", "--json", "--force", agentId], { detached: true, stdio: "ignore" }).unref();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorText(e: unknown): string {
  const stderr = (e as { stderr?: string }).stderr?.trim();
  const answer = parseJson(stderr ?? "");
  if (Value.Check(cliError, answer)) return `${answer.error.code}: ${answer.error.message}`;
  return stderr || (e as Error).message;
}
