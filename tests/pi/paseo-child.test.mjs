// `pi agent host: paseo`: the extension against a fake `paseo` on PATH, and the
// child side against the handoff its parent gives it.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentRunner, sessionFile } from "../../plugins/pstack/pi/agents.ts";
import { defaultSettings, takeHandoff } from "../../plugins/pstack/pi/config.ts";
import { install } from "../../plugins/pstack/pi/index.ts";
import { PaseoChild } from "../../plugins/pstack/pi/paseo-child.ts";
import { writeSheet } from "../session-hook-sheets.mjs";
import { agentEntry, fakeCtx, fakePi, gitRepo, listAgents, readEntries, recordWith, restore, resultText, sleep, useWorld, waitFor } from "./harness.mjs";

const FAKE_PASEO = fileURLToPath(new URL("./fake-paseo.mjs", import.meta.url));
const CALLER = "parent-agent";
const LINE = "pi agent host: paseo\n";
const { PATH, HC_TERMINAL_ID, PASEO_AGENT_ID } = process.env;

const sessions = [];
const scratch = [];
const scratchDir = (name) => {
  scratch.push(mkdtempSync(join(tmpdir(), name)));
  return scratch.at(-1);
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true });
});
// Registered before useWorld's cleanup, so the shutdown still finds the world.
afterEach(async () => {
  for (const { pi, ctx } of sessions.splice(0)) await pi.emit("session_shutdown", {}, ctx);
  process.env.PATH = PATH;
  delete process.env.FAKE_PASEO_DIR;
  for (const [name, value] of Object.entries({ HC_TERMINAL_ID, PASEO_AGENT_ID })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
const setup = useWorld();

function fakePaseo(script) {
  const dir = scratchDir("pstack-fake-paseo-");
  mkdirSync(join(dir, "bin"));
  symlinkSync(FAKE_PASEO, join(dir, "bin", "paseo"));
  process.env.PATH = `${join(dir, "bin")}${delimiter}${PATH}`;
  process.env.FAKE_PASEO_DIR = dir;
  const set = (next) => writeFileSync(join(dir, "script.json"), JSON.stringify(next));
  set(script);
  const calls = (command) => (existsSync(join(dir, "calls.jsonl")) ? readEntries(join(dir, "calls.jsonl")).filter((c) => c.command === command) : []);
  return { dir, set, calls, archived: () => calls("archive").map((c) => c.argv.at(-1)) };
}

function paseo({ script = {}, sheet = LINE, caller = CALLER, ...options } = {}) {
  const fake = fakePaseo(script);
  const { w, pi, ctx } = setup({ sheet, settings: { paseoAgent: caller }, ...options });
  w.settings.paseoAgent = caller;
  sessions.push({ pi, ctx });
  const run = (prompt, params = {}) => pi.call("agent", { description: prompt.slice(0, 40), prompt, ...params }, ctx);
  const start = async (prompt) => (await run(prompt, { run_in_background: true })).details.agentId;
  const resumed = async (entries) => {
    const next = await restore(w, entries);
    sessions.push({ pi: next, ctx });
    return next;
  };
  return { ...fake, w, pi, ctx, run, start, resumed, last: () => pi.entries.at(-1).data };
}

const noticeText = (pi, n = 0) => pi.messages[n].message.content;
const userTexts = (file) => readEntries(file).filter((e) => e.type === "message" && e.message.role === "user").map((e) => e.message.content[0].text);
const envOf = (run) => Object.fromEntries(run.argv.flatMap((arg, i) => (run.argv[i - 1] === "--env" ? [[arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]] : [])));
const SLOW = [{ toolUse: true }, { hang: true }];

describe("the paseo host", () => {
  test("the sheet line starts each agent as a Paseo agent under this one, before hc, and takes its reply from its Pi session", async () => {
    process.env.HC_TERMINAL_ID = "t1";
    const { run, calls, w, pi, last } = paseo({ sheet: `pi agent host: hc\n${LINE}` });
    const result = await run('look & <see> "this"', { description: "find the bug", subagent_type: "pstack:poteto-agent", model: "haiku", effort: "low", readonly: true });

    expect(result.isError).toBe(false);
    expect(resultText(result)).toContain('reply to: look & <see> "this"');
    const id = result.details.agentId;
    const dir = join(w.agentDir, "pstack", "parent-session", "agents", id);
    const [launch] = calls("run");
    expect(launch.caller).toBe(CALLER);
    expect(launch.argv.filter((arg, i) => arg !== "--env" && launch.argv[i - 1] !== "--env")).toEqual([
      "--json", "--no-wait", "--provider", "pi/anthropic/fixture-haiku", "--title", "find the bug", "--cwd", w.cwd, "--label", `pstack=${id}`, "--thinking", "low", "--", "pstack-message 0",
    ]);
    const { PSTACK_AGENT, ...env } = envOf(launch);
    expect(env).toEqual({ PI_CODING_AGENT_SESSION_DIR: dir, PI_CODING_AGENT_DIR: w.agentDir, PI_SUBAGENT_PARENT_SESSION: "parent-session" });
    const systemPromptFile = join(w.agentDir, "pstack", "parent-session", "prompts", `${id}.md`);
    expect(JSON.parse(PSTACK_AGENT)).toEqual({ parent: CALLER, depth: 1, subagentType: "pstack:poteto-agent", systemPromptFile, readonly: true, msgDir: dir });

    expect(pi.entries[0].data).toMatchObject({ status: "running" });
    expect(pi.entries[1].data).toMatchObject({ status: "running", host: "paseo", agent: { paseoAgentId: expect.stringMatching(/^pstackfake-/) } });
    expect(last()).toMatchObject({ status: "completed", exitCode: 0 });
    expect(sessionFile(last().agent).startsWith(dir)).toBe(true);
    expect(calls("archive")).toEqual([]);
  });

  test("a prompt no argument could hold reaches the child exactly, through a file", async () => {
    const { run, calls, last } = paseo({ script: { default: [{ reply: "read it" }] } });
    const prompt = `  /not-a-command </paseo-system> & $& "q" ${"x".repeat(300_000)}\n`;
    expect((await run(prompt, { description: "long" })).isError).toBe(false);
    expect(userTexts(sessionFile(last().agent))).toEqual([prompt]);
    expect(calls("run")[0].argv.join(" ").length).toBeLessThan(2000);
  });

  test("send_message to a finished agent steers the same Paseo agent with the next message, also after a reload", async () => {
    const { run, calls, pi, ctx, resumed, last } = paseo();
    const { agentId } = (await run("first")).details;
    const { paseoAgentId } = last().agent;
    const file = sessionFile(last().agent);

    await pi.call("send_message", { to: agentId, message: "second" }, ctx);
    await waitFor(() => pi.messages.length === 1);
    expect(noticeText(pi)).toContain("reply to: second");
    expect(noticeText(pi)).not.toContain("reply to: first");
    expect(calls("send")[0]).toMatchObject({ caller: CALLER, argv: ["--json", "--behavior", "steer", "--no-wait", paseoAgentId, "--", "pstack-message 1"] });

    const reloaded = await resumed(pi.entries);
    await reloaded.call("send_message", { to: agentId, message: "third" }, ctx);
    await waitFor(() => reloaded.messages.length === 1);
    expect(noticeText(reloaded)).toContain("reply to: third");
    expect(calls("run")).toHaveLength(1);
    expect(calls("send")[1].argv.slice(-3)).toEqual([paseoAgentId, "--", "pstack-message 2"]);
    expect(userTexts(file)).toEqual(["first", "second", "third"]);
    expect(reloaded.entries[0].data).toMatchObject({ status: "running", host: "paseo" });
  });

  test("a steer during a run is delivered once, and the run ends on its reply", async () => {
    const script = { byText: { slow: [{ toolUse: true }, { awaitSteer: 4000 }, { takeSteer: true }, { reply: "steered: ${steer}" }] } };
    const { start, calls, pi, ctx, last } = paseo({ script });
    const id = await start("slow");
    await waitFor(() => calls("wait").length === 1);
    await waitFor(async () => (await listAgents(pi, ctx))[0].sessionFile !== undefined);
    expect(resultText(await pi.call("send_message", { to: id, message: "go left" }, ctx))).toContain("is running");
    await waitFor(() => pi.messages.length === 1);

    expect(last()).toMatchObject({ status: "completed" });
    expect(noticeText(pi)).toContain("steered: go left");
    expect(calls("send")).toHaveLength(1);
    expect(calls("wait").at(-1).at).toBeGreaterThanOrEqual(calls("sent")[0].at);
  });

  for (const [name, script] of [
    ["the wait answers idle before the child read the steer", { byText: { task: [{ reply: "first answer" }, { awaitSend: 4000 }, { idle: true }] } }],
    ["the send is still in flight when the wait answers idle", { byText: { task: [{ sleep: 300 }, { reply: "first answer" }] }, sendMs: 800 }],
  ]) {
    test(`the run waits for a steer's reply when ${name}`, async () => {
      const { start, calls, pi, ctx } = paseo({ script });
      const id = await start("task");
      await waitFor(() => calls("wait").length === 1);
      await pi.call("send_message", { to: id, message: "also this" }, ctx);
      await waitFor(() => pi.messages.length === 1);
      expect(noticeText(pi)).toContain("reply to: also this");
      expect(noticeText(pi)).not.toContain("first answer");
      expect(calls("send")).toHaveLength(1);
    });
  }

  test("a steer after the run settled is not sent", async () => {
    const { dir: fakeDir, calls } = fakePaseo({});
    const dir = join(fakeDir, "child");
    mkdirSync(dir);
    const handoff = { parent: CALLER, depth: 1, subagentType: "general-purpose", msgDir: dir };
    const transcript = () => readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n))[0];
    const target = { title: "t", cwd: dir, label: "pstack=a1", env: { PI_CODING_AGENT_SESSION_DIR: dir, PSTACK_AGENT: JSON.stringify(handoff) } };
    const child = new PaseoChild({ caller: CALLER, dir, target, onAgent: () => {}, transcript }, "hello");
    expect(await child.exited).toEqual({ exitCode: 0, settled: true, finalText: "reply to: hello", errorMessage: "", interruption: undefined, stderr: "" });
    expect(await child.steer("late")).toEqual({ response: undefined, taken: false });
    expect(calls("send")).toEqual([]);
    expect(existsSync(join(dir, "msg-1.md"))).toBe(false);
  });

  test("a steer Paseo refuses is reported as not taken", async () => {
    const { start, calls, pi, ctx } = paseo({ script: { default: SLOW, sendError: "DAEMON_NOT_RUNNING" } });
    const id = await start("task");
    await waitFor(() => calls("wait").length === 1);
    await expect(pi.call("send_message", { to: id, message: "more" }, ctx)).rejects.toThrow("did not take the message: DAEMON_NOT_RUNNING: the daemon said no");
  });

  test("stop_agent archives a running agent, which ends its process, and a later message resumes it", async () => {
    const { start, calls, archived, pi, ctx, last, set } = paseo({ script: { default: SLOW } });
    const id = await start("task");
    await waitFor(() => calls("wait").length === 1);
    const stopped = await pi.call("stop_agent", { id }, ctx);

    expect(stopped.details.status).toBe("stopped");
    const { paseoAgentId } = last().agent;
    expect(calls("archive").map((c) => c.argv)).toEqual([["--json", "--force", paseoAgentId]]);
    expect(calls("timeline")).toEqual([]);
    expect(calls("stop")).toEqual([]);
    expect(pi.messages[0].options).toEqual({ triggerTurn: false });

    set({});
    await pi.call("send_message", { to: id, message: "again" }, ctx);
    await waitFor(() => pi.messages.length === 2);
    expect(noticeText(pi, 1)).toContain("reply to: again");
    expect(archived()).toEqual([paseoAgentId]);
  });

  test("a finished agent stays idle until stop_agent, which keeps its status", async () => {
    const { run, calls, archived, pi, ctx, last } = paseo();
    const { agentId } = (await run("done")).details;
    expect(calls("archive")).toEqual([]);
    expect((await pi.call("stop_agent", { id: agentId }, ctx)).details.status).toBe("completed");
    expect(archived()).toEqual([last().agent.paseoAgentId]);
  });

  test("the session's end archives its running agents and its finished ones", async () => {
    const { run, start, calls, archived, pi, ctx } = paseo({ script: { byText: { task: SLOW } } });
    await run("done");
    await start("task");
    await waitFor(() => calls("wait").length === 2);
    await pi.emit("session_shutdown", {}, ctx);
    expect(new Set(archived()).size).toBe(2);
    expect(calls("timeline")).toEqual([]);
  });

  test("an exit that cannot wait still archives running and finished agents", async () => {
    const { calls, archived, w, pi, ctx } = paseo({ script: { byText: { task: SLOW } } });
    const runner = new AgentRunner(pi.api, w.settings);
    await runner.wait(runner.start({ description: "done", prompt: "done" }, ctx).agent.id);
    runner.start({ description: "slow", prompt: "task", run_in_background: true }, ctx);
    await waitFor(() => calls("wait").length === 2);
    runner.signalAll();
    await waitFor(() => new Set(archived()).size === 2);
    await waitFor(() => !runner.busy);
    await sleep(300);
    expect(calls("timeline")).toEqual([]);
  });

  for (const [name, steps, why] of [
    ["typed into it", [{ toolUse: true }, { typed: "do something else" }, { reply: "the user's answer" }], "interrupted by input typed in Paseo"],
    ["typed into it without interrupting", [{ toolUse: true }, { follow: "and this" }, { reply: "the user's answer" }], "interrupted by input typed in Paseo"],
    ["pressed stop", [{ toolUse: true }, { stopped: true }], "stopped in Paseo"],
  ]) {
    test(`a run the user ${name} ends stopped, without the user's reply, and tells the model`, async () => {
      const { start, pi, last } = paseo({ script: { default: steps } });
      await start("task");
      await waitFor(() => pi.messages.length === 1);
      expect(last()).toMatchObject({ status: "stopped", finalText: why });
      expect(pi.messages[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    });
  }

  test("what the user types after the reply does not replace it", async () => {
    const { run } = paseo({ script: { default: [{ reply: "my answer" }, { follow: "thanks" }, { reply: "you're welcome" }] } });
    const result = await run("task");
    expect(result.details.status).toBe("completed");
    expect(resultText(result)).toContain("my answer");
    expect(resultText(result)).not.toContain("you're welcome");
  });

  test("a permission wait is waited out", async () => {
    const { run, calls } = paseo({ script: { default: [{ permission: true }, { reply: "granted" }] } });
    expect(resultText(await run("task"))).toContain("granted");
    expect(calls("wait")).toHaveLength(2);
  });

  for (const [name, script, why, archives] of [
    ["Paseo reports an error", { default: [{ error: "pi exited" }] }, "pi exited", 1],
    ["the turn ends in a model error", { default: [{ failed: "overloaded" }] }, "overloaded", 0],
    ["the child's pstack does not know the handoff", { oldPstack: true }, "the pstack installed in Pi is too old for pi agent host: paseo", 1],
    ["Paseo cannot start it", { runError: "DAEMON_NOT_RUNNING" }, "DAEMON_NOT_RUNNING: the daemon said no", 0],
  ]) {
    test(`a run fails when ${name}`, async () => {
      const { run, calls, last } = paseo({ script });
      const result = await run("task");
      expect(result.details.status).toBe("failed");
      expect(last().finalText).toContain(why);
      expect(calls("archive")).toHaveLength(archives);
    });
  }

  test("a worktree agent runs as an rpc child, since Paseo starts a child in its parent's folder", async () => {
    const { run, calls, w } = paseo();
    gitRepo(w.cwd);
    await run("task", { isolation: "worktree" });
    expect(w.invocations()).toHaveLength(1);
    expect(calls("run")).toEqual([]);
  });

  for (const [name, options] of [
    ["without the sheet line", { sheet: "pi agent host: rpc\n" }],
    ["in a session that is not a Paseo agent", { caller: "" }],
  ]) {
    test(`${name}, agents run as rpc children`, async () => {
      const { run, calls, w } = paseo(options);
      await run("task");
      expect(w.invocations()).toHaveLength(1);
      expect(calls("run")).toEqual([]);
    });
  }

  test("an agent stays on the host it first ran on", async () => {
    const { run, calls, w, pi, ctx } = paseo({ sheet: "" });
    const { agentId } = (await run("task")).details;
    writeSheet(join(w.agentDir, "pstack-models.md"), LINE);
    await pi.call("send_message", { to: agentId, message: "again" }, ctx);
    await w.until("invocation", 2);
    expect(calls("run")).toEqual([]);
  });

  test("a Paseo agent cannot be messaged from a session that is not a Paseo agent", async () => {
    const { run, calls, w, pi, ctx, resumed } = paseo();
    const { agentId } = (await run("task")).details;
    delete w.settings.paseoAgent;
    const outside = await resumed(pi.entries);
    await expect(outside.call("send_message", { to: agentId, message: "again" }, ctx)).rejects.toThrow("from a Pi session running as a Paseo agent");
    expect(calls("send")).toEqual([]);
  });
});

describe("restoring a Paseo agent", () => {
  // A record as a session leaves it while its agent runs, launched by a pi that is gone.
  async function interrupted(options = {}) {
    const env = paseo(options);
    await env.run("task");
    const gone = env.w.spawn("true", []);
    await new Promise((r) => gone.on("exit", r));
    const record = recordWith(env.pi.entries[1].data, { parentPid: gone.pid });
    return { ...env, record, id: record.agent.id, paseoAgentId: record.agent.paseoAgentId };
  }
  const status = async (pi, ctx) => (await listAgents(pi, ctx))[0].status;

  test("an agent whose launching pi still runs is left alone", async () => {
    const { record, id, w, calls, ctx, resumed } = await interrupted();
    const launcher = w.spawn("sleep", ["30"]);
    const next = await resumed([agentEntry({ ...record, parentPid: launcher.pid })]);
    expect(await status(next, ctx)).toBe("running");
    await expect(next.call("send_message", { to: id, message: "x" }, ctx)).rejects.toThrow("running under another pi process");
    expect(calls("inspect")).toEqual([]);
    expect(calls("archive")).toEqual([]);
  });

  for (const paseoStatus of ["idle", "running"]) {
    test(`an orphan that is ${paseoStatus} is archived, and then counts as stopped`, async () => {
      const { record, paseoAgentId, set, archived, ctx, resumed } = await interrupted();
      set({ inspect: { status: paseoStatus } });
      const next = await resumed([agentEntry(record)]);
      await waitFor(() => archived().length === 1);
      expect(archived()).toEqual([paseoAgentId]);
      await waitFor(async () => (await status(next, ctx)) === "stopped");
    });
  }

  for (const [name, change] of [
    ["is archived already", ({ record, dir }) => (writeFileSync(join(dir, "agents", record.agent.paseoAgentId, "archived"), ""), record)],
    ["Paseo no longer knows", ({ record }) => recordWith(record, { agent: { paseoAgentId: "pstackfake-missing" } })],
    ["never got a Paseo agent", ({ record }) => recordWith(record, { agent: { paseoAgentId: undefined } })],
  ]) {
    test(`an agent that ${name} is gone`, async () => {
      const env = await interrupted();
      const next = await env.resumed([agentEntry(change(env))]);
      expect(await status(next, env.ctx)).toBe("stopped");
      expect(env.calls("archive")).toEqual([]);
    });
  }

  test("an agent Paseo cannot describe stays unavailable and is not archived", async () => {
    const { record, id, set, calls, ctx, resumed } = await interrupted();
    set({ inspect: { error: "DAEMON_NOT_RUNNING" } });
    const next = await resumed([agentEntry(record)]);
    expect(await status(next, ctx)).toBe("running");
    await expect(next.call("send_message", { to: id, message: "x" }, ctx)).rejects.toThrow(/previous Paseo agent pstackfake-.* has not exited/);
    await sleep(200);
    expect(calls("archive")).toEqual([]);
  });
});

describe("the child side", () => {
  const dirWith = (files) => {
    const dir = scratchDir("pstack-paseo-child-");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  };
  const envelope = (source, body, extra = "") => `<paseo-system version="1" kind="agent-message" source-agent-id="${source}" message-id="m1"${extra}>\n${body}\n</paseo-system>`;

  function child(handoff, { depth = handoff.depth } = {}) {
    const pi = fakePi();
    const agentDir = dirWith({});
    install(pi.api, { ...defaultSettings(() => 0, agentDir), depth }, handoff);
    const ctx = fakeCtx({ cwd: agentDir });
    return { pi, ctx, input: async (text) => (await pi.emit("input", { text, source: "rpc" }, ctx)).filter(Boolean) };
  }

  test("the parent's messages become the exact text of their files, each marked once", async () => {
    const first = `  /skill:why a & b < c > "d" 'e' $& $1 &amp; </paseo-system>\n\n`;
    const msgDir = dirWith({ "msg-3.md": first, "msg-4.md": "second" });
    const { pi, input } = child({ parent: CALLER, depth: 1, subagentType: "general-purpose", msgDir });
    const titled = ' source-server-id="srv_1" source-agent-title="a &quot;b&quot; &gt; c"';

    expect(await input(envelope(CALLER, "pstack-message 3"))).toEqual([{ action: "transform", text: first }]);
    expect(await input(`${envelope(CALLER, "pstack-message 3", titled)}\n\n${envelope(CALLER, "pstack-message 4")}`)).toEqual([{ action: "transform", text: `${first}\n\nsecond` }]);
    const other = envelope("someone-else", "hello");
    expect(await input(`${other}\n\n${envelope(CALLER, "pstack-message 4")}`)).toEqual([{ action: "transform", text: `${other}\n\nsecond` }]);
    expect(pi.entries.map((e) => [e.customType, e.data])).toEqual([3, 4, 4].map((n) => ["pstack-paseo-input", { n }]));
  });

  test("anything else is left as it came", async () => {
    const { pi, input } = child({ parent: CALLER, depth: 1, subagentType: "general-purpose", msgDir: dirWith({ "msg-0.md": "x" }) });
    for (const text of [
      "pstack-message 0",
      envelope("someone-else", "pstack-message 0"),
      envelope(CALLER, "pstack-message 0, please"),
      `<paseo-system version="1" kind="user-message" message-id="m1">\n&lt;paseo-system version=&quot;1&quot;&gt;\npstack-message 0\n</paseo-system>`,
    ]) {
      expect(await input(text)).toEqual([]);
    }
    expect(pi.entries).toEqual([]);
  });

  test("its runs get the agent's system prompt and tag, and lack the tools a flag would exclude", async () => {
    const msgDir = dirWith({ "body.md": "You are a careful reader." });
    const { pi, ctx } = child({ parent: CALLER, depth: 3, subagentType: "pstack:poteto-agent", systemPromptFile: join(msgDir, "body.md"), readonly: true, msgDir });
    const options = { appendSystemPrompt: "from the project", sections: {} };
    await pi.emit("before_agent_start", { systemPromptOptions: options }, ctx);

    expect(options.appendSystemPrompt).toBe('from the project\n\nYou are a careful reader.\n\n<active_agent name="pstack:poteto-agent" />');
    expect(pi.api.getActiveTools()).toEqual(["read", "bash"]);
    for (const toolName of ["edit", "write", "agent"]) {
      expect((await pi.emit("tool_call", { toolName, input: {} }, ctx)).filter(Boolean)).toEqual([{ block: true, reason: `This agent has no ${toolName} tool.` }]);
    }
    expect((await pi.emit("tool_call", { toolName: "read", input: {} }, ctx)).filter(Boolean)).toEqual([]);
  });

  test("a prompt another extension replaced whole still gets the agent's", async () => {
    const { pi, ctx } = child({ parent: CALLER, depth: 1, subagentType: "general-purpose", msgDir: dirWith({}) });
    const event = { systemPrompt: "replaced", systemPromptOptions: { forceSystemPrompt: "replaced", sections: {} } };
    const results = await pi.emit("before_agent_start", event, ctx);
    expect(results.filter(Boolean)).toEqual([{ systemPrompt: 'replaced\n\n<active_agent name="general-purpose" />' }]);
  });

  test("an agent above the depth limit with write access keeps every tool", async () => {
    const { pi, ctx } = child({ parent: CALLER, depth: 2, subagentType: "general-purpose", msgDir: dirWith({}) });
    const options = { sections: {} };
    await pi.emit("before_agent_start", { systemPromptOptions: options }, ctx);
    expect(options.appendSystemPrompt).toBe('<active_agent name="general-purpose" />');
    expect(pi.api.getActiveTools()).toEqual(["read", "bash", "edit", "write", "agent"]);
  });

  test("the handoff is read once and leaves the environment", () => {
    const handoff = { parent: CALLER, depth: 2, subagentType: "general-purpose", msgDir: "/m" };
    const env = { PSTACK_AGENT: JSON.stringify(handoff), HOME: "/h" };
    expect(takeHandoff(env)).toEqual(handoff);
    expect(env).toEqual({ HOME: "/h" });
    expect(takeHandoff(env)).toBeUndefined();
    expect(() => takeHandoff({ PSTACK_AGENT: JSON.stringify({ ...handoff, depth: 0 }) })).toThrow("PSTACK_AGENT is not a pstack handoff");
  });

  test("the handoff gives the depth, the flag wins, and only a session without the flag is its Paseo agent", () => {
    const handoff = { parent: CALLER, depth: 2, subagentType: "general-purpose", msgDir: "/m" };
    process.env.PASEO_AGENT_ID = "me";
    expect([defaultSettings(() => 0, "/a", handoff).depth, defaultSettings(() => 1, "/a", handoff).depth, defaultSettings(() => 0, "/a").depth]).toEqual([2, 1, 0]);
    expect(defaultSettings(() => 0, "/a", handoff).paseoAgent).toBe("me");
    expect(defaultSettings(() => 1, "/a").paseoAgent).toBeUndefined();
  });
});
