import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import type { ChildExit } from "./child.ts";

const PROTOCOL = "2025-06-18";
const WAIT_MS = 30_000;

const toolResult = Type.Object({
  content: Type.Optional(Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) }))),
  structuredContent: Type.Optional(Type.Unknown()),
  isError: Type.Optional(Type.Boolean()),
});
const delegated = Type.Object({ taskId: Type.String(), childThreadId: Type.String(), childRunId: Type.String() });
const sent = Type.Object({ taskId: Type.Optional(Type.String()), runId: Type.String(), delivery: Type.String() });
const waited = Type.Object({ timedOut: Type.Boolean() });
const taskResult = Type.Object({ status: Type.String(), summary: Type.Union([Type.String(), Type.Null()]) });

export interface T3Session {
  endpoint: string;
  token: string;
}

export function t3Session(): T3Session | undefined {
  const endpoint = process.env.T3_MCP_URL;
  const token = process.env.T3_MCP_BEARER_TOKEN;
  return endpoint && token ? { endpoint, token } : undefined;
}

export interface T3Launch {
  title: string;
  model?: string;
  thinking?: string;
  threadId?: string;
  onThread: (threadId: string) => void;
}

export class T3Child {
  readonly pid = undefined;
  readonly activity = undefined;
  readonly exited: Promise<ChildExit>;
  private readonly mcp: T3Mcp;
  private threadId?: string;
  private taskId?: string;
  private settled = false;
  private ending = false;

  constructor(session: T3Session, launch: T3Launch, prompt: string) {
    this.mcp = new T3Mcp(session);
    this.exited = this.drive(launch, prompt);
  }

  async steer(message: string): Promise<{ response: { success: boolean } | undefined; taken: boolean }> {
    if (this.settled || this.threadId === undefined) return { response: undefined, taken: false };
    try {
      const { delivery } = await this.mcp.call(sent, "t3_thread_send", { threadId: this.threadId, message, mode: "steer" });
      return { response: { success: true }, taken: delivery === "steered" && !this.settled };
    } catch {
      return { response: undefined, taken: false };
    }
  }

  end(): void {
    this.ending = true;
    void this.cancel();
  }

  signal(): void {
    this.end();
  }

  private async drive(launch: T3Launch, prompt: string): Promise<ChildExit> {
    try {
      const runId = await this.start(launch, prompt);
      if (this.ending) await this.cancel();
      await this.wait(runId);
      const { status, summary } = await this.mcp.call(taskResult, "task_status", { taskId: this.taskId });
      this.settled = status === "completed";
      const text = summary ?? "";
      if (this.settled) return { exitCode: 0, settled: true, finalText: text, errorMessage: "", stderr: "" };
      return { exitCode: null, settled: false, finalText: "", errorMessage: text || `The T3 Code task ended with status ${status}.`, stderr: "" };
    } catch (e) {
      return { exitCode: null, settled: false, finalText: "", errorMessage: (e as Error).message, stderr: "" };
    }
  }

  private async start(launch: T3Launch, prompt: string): Promise<string> {
    if (launch.threadId !== undefined) {
      this.threadId = launch.threadId;
      const { taskId, runId } = await this.mcp.call(sent, "t3_thread_send", { threadId: launch.threadId, message: prompt, mode: "auto" });
      this.taskId = taskId;
      return runId;
    }
    const target = { ...(launch.model && { model: launch.model }), ...(launch.thinking && { options: { thinking: launch.thinking } }) };
    const task = await this.mcp.call(delegated, "delegate_task", { task: prompt, title: launch.title, target, mode: "async" });
    this.threadId = task.childThreadId;
    this.taskId = task.taskId;
    launch.onThread(task.childThreadId);
    return task.childRunId;
  }

  private async wait(runId: string): Promise<void> {
    for (;;) {
      const { timedOut } = await this.mcp.call(waited, "t3_thread_wait", { threadId: this.threadId, runId, timeoutMs: WAIT_MS, untilDelegatedWorkSettled: true });
      if (!timedOut) return;
    }
  }

  private async cancel(): Promise<void> {
    if (this.taskId === undefined) return;
    await this.mcp.call(Type.Unknown(), "task_cancel", { taskId: this.taskId, reason: "stop_agent" }).catch(() => undefined);
  }
}

class T3Mcp {
  private nextId = 1;
  private sessionId?: string;
  private ready?: Promise<unknown>;

  constructor(private readonly session: T3Session) {}

  async call<T extends TSchema>(schema: T, name: string, args: Record<string, unknown>): Promise<Static<T>> {
    this.ready ??= this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "pstack", version: "1" } }).then(() =>
      this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    );
    await this.ready;
    const result = await this.request("tools/call", { name, arguments: args });
    if (!Value.Check(toolResult, result)) throw new Error(`T3 Code ${name} answered: ${JSON.stringify(result).slice(0, 300)}`);
    const text = result.content?.find((part) => part.type === "text")?.text ?? "";
    if (result.isError) throw new Error(`T3 Code ${name} failed: ${text.slice(0, 1000)}`);
    const value = result.structuredContent ?? JSON.parse(text);
    if (!Value.Check(schema, value)) throw new Error(`T3 Code ${name} answered: ${text.slice(0, 300)}`);
    return value;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const response = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params });
    const body = await response.text();
    if (!response.ok) throw new Error(`T3 Code MCP ${method} failed (${response.status}): ${body.slice(0, 300)}`);
    const reply = rpcReply(body, response.headers.get("content-type") ?? "");
    if (reply.error) throw new Error(`T3 Code MCP ${method} failed: ${reply.error.message ?? JSON.stringify(reply.error)}`);
    return reply.result;
  }

  private async post(message: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.session.token}`,
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL,
      ...(this.sessionId && { "mcp-session-id": this.sessionId }),
    };
    const response = await fetch(this.session.endpoint, { method: "POST", headers, body: JSON.stringify(message) });
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    return response;
  }
}

function rpcReply(body: string, contentType: string): { result?: unknown; error?: { message?: string } } {
  if (!contentType.includes("text/event-stream")) return JSON.parse(body);
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const reply = JSON.parse(line.slice(5));
    if (reply.id !== undefined) return reply;
  }
  throw new Error("T3 Code MCP sent an event stream with no reply.");
}
