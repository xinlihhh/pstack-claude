import { execFile } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import { alive, type ChildExit, signalGroup, terminateGroup } from "./child.ts";
import { envScript, jsonLines, replyOf, sizeOf } from "./hc-child.ts";

const execOrca = promisify(execFile);
const SETTLE_POLL_MS = 500;
const CLOSE_POLL_MS = 200;

const createResult = Type.Object({ result: Type.Object({ terminal: Type.Object({ handle: Type.String(), processId: Type.Number() }) }) });
const sendResult = Type.Object({ result: Type.Object({ send: Type.Object({ accepted: Type.Boolean() }) }) });
const readResult = Type.Object({ result: Type.Object({ terminal: Type.Object({ tail: Type.Array(Type.String()) }) }) });
const failedResult = Type.Object({ error: Type.Object({ message: Type.String() }) });
const messageEntry = Type.Object({
  type: Type.Literal("message"),
  message: Type.Object({ role: Type.String(), stopReason: Type.Optional(Type.String()) }),
});

export interface OrcaSession {
  cli: string;
  workspace: string;
}

export function orcaSession(env: NodeJS.ProcessEnv = process.env): OrcaSession | undefined {
  const { ORCA_TERMINAL_HANDLE: handle, ORCA_CLI_COMMAND: cli, ORCA_WORKTREE_ID: workspace } = env;
  return handle && cli && workspace ? { cli, workspace } : undefined;
}

export function settledRun(entries: unknown[], steers: number): Pick<ChildExit, "interruption"> | undefined {
  const messages = entries.filter((entry) => Value.Check(messageEntry, entry)).map((entry) => entry.message);
  const last = messages.at(-1);
  // Counted, not matched by text: a TUI may reshape pasted text.
  const users = messages.filter((message) => message.role === "user").length;
  if (users < 1 + steers || last?.role !== "assistant" || last.stopReason === "toolUse") return undefined;
  return { interruption: last.stopReason === "aborted" ? "stopped in Orca" : undefined };
}

export interface OrcaOptions {
  session: OrcaSession;
  title: string;
  cwd: string;
  env: Record<string, string | undefined>;
  files: string;
  graceMs: number;
  transcript: () => string | undefined;
  onStart: (pid: number) => void;
}

export class OrcaChild {
  readonly pid = undefined;
  readonly activity = undefined;
  readonly exited: Promise<ChildExit>;
  private readonly cli: string;
  private handle?: string;
  private terminalPid?: number;
  private steers = 0;
  private settled = false;
  private ending = false;

  constructor(command: string, args: string[], opts: OrcaOptions, prompt: string) {
    this.cli = opts.session.cli;
    const files = { env: `${opts.files}.env`, prompt: `${opts.files}.prompt`, script: `${opts.files}.sh` };
    writeFileSync(files.env, envScript({ ...process.env, ...opts.env }, "ORCA_"), { mode: 0o600 });
    // Pi reads an argument that starts with @ as a file, even after --.
    writeFileSync(files.prompt, prompt.startsWith("@") ? ` ${prompt}` : prompt, { mode: 0o600 });
    const launch = `. ${quote(files.env)} && p=$(cat ${quote(files.prompt)}) && cd ${quote(opts.cwd)} && exec ${[command, ...args].map(quote).join(" ")} -- "$p"\n`;
    writeFileSync(files.script, launch, { mode: 0o600 });
    this.exited = this.drive(files, opts);
  }

  async steer(message: string): Promise<{ response: { success: boolean } | undefined; taken: boolean }> {
    if (!this.settled && this.handle !== undefined) {
      // Counted before the send, so the run cannot settle while the message is on its way.
      this.steers++;
      const sent = await this.orca(sendResult, ["terminal", "send", `--terminal=${this.handle}`, `--text=${message}`, "--enter"]).catch(() => undefined);
      if (sent?.result.send.accepted) return { response: { success: true }, taken: !this.settled };
      this.steers--;
    }
    return { response: undefined, taken: false };
  }

  end(graceMs: number): void {
    this.ending = true;
    this.stop(graceMs);
  }

  signal(signal: NodeJS.Signals): void {
    if (this.terminalPid !== undefined) signalGroup(this.terminalPid, signal);
  }

  private async drive(files: Record<string, string>, opts: OrcaOptions): Promise<ChildExit> {
    const from = sizeOf(opts.transcript());
    const written = () => {
      const file = opts.transcript();
      return file ? jsonLines(readFileSync(file).subarray(from).toString("utf8")) : [];
    };
    try {
      const create = ["terminal", "create", `--worktree=id:${opts.session.workspace}`, `--title=${opts.title}`, `--command=exec sh ${quote(files.script)}`];
      const { handle, processId } = (await this.orca(createResult, create)).result.terminal;
      this.handle = handle;
      this.terminalPid = processId;
      opts.onStart(processId);
      if (this.ending) this.stop(opts.graceMs);
      let run: Pick<ChildExit, "interruption"> | undefined;
      while (!run && alive(processId)) {
        await sleep(SETTLE_POLL_MS);
        if (alive(processId)) run = settledRun(written(), this.steers);
      }
      this.settled = run !== undefined;
      const entries = written();
      const stderr = this.settled || this.ending ? "" : await this.screen();
      await this.close(opts.graceMs);
      return { exitCode: null, settled: this.settled, ...replyOf(entries), interruption: run?.interruption, stderr };
    } catch (e) {
      await this.close(opts.graceMs);
      return { exitCode: null, settled: false, finalText: replyOf(written()).finalText, errorMessage: orcaError(e), stderr: "" };
    } finally {
      for (const file of Object.values(files)) {
        try {
          unlinkSync(file);
        } catch {}
      }
    }
  }

  private stop(graceMs: number): void {
    const pid = this.terminalPid;
    if (pid !== undefined) void terminateGroup(pid, () => alive(pid), graceMs);
  }

  private async close(graceMs: number): Promise<void> {
    this.stop(graceMs);
    while (this.terminalPid !== undefined && alive(this.terminalPid)) await sleep(CLOSE_POLL_MS);
    // Orca usually removes the tab itself once pi is gone, and then there is nothing to close.
    if (this.handle !== undefined) await execOrca(this.cli, ["terminal", "close", `--terminal=${this.handle}`, "--json"]).catch(() => undefined);
  }

  private screen(): Promise<string> {
    return this.orca(readResult, ["terminal", "read", `--terminal=${this.handle}`, "--screen"]).then(
      ({ result }) => result.terminal.tail.join("\n"),
      () => "",
    );
  }

  private async orca<T extends TSchema>(schema: T, args: string[]): Promise<Static<T>> {
    const { stdout } = await execOrca(this.cli, [...args, "--json"]);
    const answer: unknown = JSON.parse(stdout);
    if (!Value.Check(schema, answer)) throw new Error(`orca ${args[0]} ${args[1]} answered: ${stdout.trim().slice(0, 300)}`);
    return answer;
  }
}

function quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

// With --json the Orca CLI reports a failure on stdout.
function orcaError(e: unknown): string {
  const { stdout = "", stderr = "" } = e as { stdout?: string; stderr?: string };
  try {
    const answer: unknown = JSON.parse(stdout);
    if (Value.Check(failedResult, answer)) return answer.error.message;
  } catch {}
  return stderr.trim() || (e as Error).message;
}
