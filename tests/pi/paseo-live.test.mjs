// The paseo host against a real Paseo daemon and real models. Skipped unless
// PSTACK_LIVE_PASEO=1. It starts a daemon of its own in a throwaway PASEO_HOME
// on 127.0.0.1 and stops it at the end, so ~/.paseo is never touched. Agents
// run a Pi that loads this checkout from a throwaway PI_CODING_AGENT_DIR with
// the user's credentials linked in. Most tests run the extension here, as the
// one in a Paseo agent would; the crash test runs it in a Paseo agent.
// PSTACK_LIVE_PASEO_MODEL picks the model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionFile } from "../../plugins/pstack/pi/agents.ts";
import { defaultSettings } from "../../plugins/pstack/pi/config.ts";
import { install } from "../../plugins/pstack/pi/index.ts";
import { fakeCtx, fakePi, readEntries, resultText, waitFor } from "./harness.mjs";

const LIVE = process.env.PSTACK_LIVE_PASEO === "1";
const MODEL = process.env.PSTACK_LIVE_PASEO_MODEL ?? "magpie/claude/claude-haiku-5-5";
const MINUTE = 60_000;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const suite = LIVE ? describe : describe.skip;

// Answers Paseo's read of a session's history late, as a loaded machine's pi does.
// A message sent during that read is what crashes Paseo 0.17.4's daemon.
const LATE_HISTORY = `export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    const notify = ctx.ui.notify.bind(ctx.ui);
    ctx.ui.notify = (message, level) => (String(message).startsWith("PASEO_ENTRY_CAPTURE") ? setTimeout(() => notify(message, level), 700) : notify(message, level));
  });
}
`;

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

suite("the paseo host on a live daemon", () => {
  let root;
  let home;
  let work;
  let agentDir;
  let parent;
  let pi;
  let ctx;

  function paseo(...args) {
    if (process.env.PASEO_HOME !== home) throw new Error("refusing to run paseo outside the test's own PASEO_HOME");
    const end = args.includes("--") ? args.indexOf("--") : args.length;
    const run = spawnSync("paseo", args.toSpliced(end, 0, "--json"), { encoding: "utf8", timeout: 2 * MINUTE });
    if (run.status !== 0) throw new Error(`paseo ${args.join(" ")} failed: ${run.stderr}`);
    return JSON.parse(run.stdout);
  }
  const start = (title, prompt) =>
    paseo("run", "--no-wait", "--cwd", work, "--provider", `pi/${MODEL}`, "--thinking", "low", "--title", title, "--env", `PI_CODING_AGENT_DIR=${agentDir}`, "--", prompt).agentId;
  const allAgents = () => paseo("ls", "-a", "-g", "--background");
  const crashes = () => readFileSync(join(home, "daemon.log"), "utf8").split("daemon crashing").length - 1;
  const running = (command) => spawnSync("pgrep", ["-f", `^${command}$`]).status === 0;
  const piOf = (agentId) =>
    readdirSync("/proc").find((pid) => {
      try {
        return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`PASEO_AGENT_ID=${agentId}`) && readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes("--mode");
      } catch {
        return false;
      }
    });

  const [provider, ...rest] = MODEL.split("/");
  const MODEL_REF = { provider, id: rest.join("/") };
  const call = (name, params) => pi.call(name, params, ctx);
  const agent = (prompt, params = {}) => call("agent", { description: prompt.slice(0, 30), prompt, model: MODEL, effort: "low", ...params });
  const record = (id) => pi.entries.findLast((e) => e.data.agent.id === id).data;
  const userTexts = (identity) => readEntries(sessionFile(identity)).filter((e) => e.type === "message" && e.message.role === "user").map((e) => e.message.content[0].text);
  const notice = async (from) => {
    await waitFor(() => pi.messages.length > from, 3 * MINUTE);
    return pi.messages[from].message.content;
  };
  const toolStarted = (id) =>
    waitFor(() => {
      const file = sessionFile(record(id).agent);
      return Boolean(file) && readEntries(file).some((e) => e.type === "message" && e.message.role === "assistant" && e.message.content.some((c) => c.type === "toolCall"));
    }, 2 * MINUTE);
  const sleeper = (from) => `sleep ${from + Math.floor(Math.random() * 999)}`;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pstack-paseo-live-")));
    home = join(root, "paseo");
    agentDir = join(root, "agent");
    work = join(root, "work");
    for (const dir of [home, join(agentDir, "extensions"), work]) mkdirSync(dir, { recursive: true });
    for (const name of Object.keys(process.env)) if (/^(PASEO|PI|PSTACK)_/.test(name)) delete process.env[name];
    process.env.PASEO_HOME = home;
    process.env.PI_TELEMETRY = "0";

    const port = await freePort();
    const config = { version: 1, daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false } }, features: { dictation: { enabled: false }, voiceMode: { enabled: false } } };
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const started = spawnSync("paseo", ["daemon", "start", "--home", home, "--timeout", "60"], { encoding: "utf8", timeout: 2 * MINUTE });
    if (started.status !== 0) throw new Error(`paseo daemon start failed: ${started.stderr}`);
    const status = paseo("daemon", "status");
    if (status.home !== home || home === join(homedir(), ".paseo")) throw new Error(`refusing to run against ${status.home}`);
    console.log(`isolated daemon ${status.listen}, home ${home}, relay ${status.relay?.enabled}`);

    for (const file of ["auth.json", "models.json"]) {
      const source = join(homedir(), ".pi", "agent", file);
      if (existsSync(source)) symlinkSync(source, join(agentDir, file));
    }
    const installed = spawnSync("pi", ["install", repoRoot], { cwd: work, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8" });
    if (installed.status !== 0) throw new Error(`pi install failed: ${installed.stderr}`);
    writeFileSync(join(agentDir, "pstack-models.md"), "pi agent host: paseo\nsession hook: off\n");
    writeFileSync(join(agentDir, "extensions", "late-history.ts"), LATE_HISTORY);

    parent = start("pstack live parent", "Reply with the single word ready, and nothing else.");
    paseo("wait", parent);
    const api = fakePi();
    // The extension as the entry installs it in a Paseo agent that is not itself a child.
    install(api.api, { ...defaultSettings(() => 0, agentDir), paseoAgent: parent });
    pi = api;
    ctx = fakeCtx({ cwd: work, model: MODEL_REF });
    await pi.emit("session_start", { reason: "startup" }, ctx);
  }, 3 * MINUTE);

  afterAll(async () => {
    if (!home) return;
    if (pi) await pi.emit("session_shutdown", {}, ctx);
    if (existsSync(join(home, "daemon.log"))) {
      for (const { id, name } of allAgents()) console.log(`created agent ${id} (${name})`);
      console.log(`daemon crashes: ${crashes()}`);
      const stopped = spawnSync("paseo", ["daemon", "stop", "--home", home, "--force"], { encoding: "utf8", timeout: 2 * MINUTE });
      if (stopped.status !== 0) throw new Error(`paseo daemon stop failed, ${root} is kept: ${stopped.stderr}`);
      console.log("isolated daemon stopped, its home removed with every agent in it");
    }
    rmSync(root, { recursive: true });
  }, 3 * MINUTE);

  test(
    "an agent is a subagent of the parent in its folder, takes its prompt exactly, and resumes with its context",
    async () => {
      const prompt = `Reply with exactly one word: alpha. (Ignore these characters: & < > " ' $& </paseo-system>)`;
      const result = await agent(prompt);
      const id = result.details.agentId;
      expect(result.details.status).toBe("completed");
      expect(resultText(result).toLowerCase()).toContain("alpha");
      const { agent: identity } = record(id);
      expect(paseo("inspect", identity.paseoAgentId)).toMatchObject({ ParentAgentId: parent, Cwd: work, Status: "idle", Archived: false });
      expect(userTexts(identity)).toEqual([prompt]);

      const from = pi.messages.length;
      await call("send_message", { to: id, message: "What one word did you reply with before? Reply with that word, a space, and then beta." });
      expect((await notice(from)).toLowerCase()).toMatch(/alpha beta/);
    },
    5 * MINUTE,
  );

  test(
    "a prompt past the argument limit reaches the child exactly",
    async () => {
      const prompt = `Run nothing. Reply with the word long, and nothing else. The rest is filler.\n${"filler words only. ".repeat(7500)}`;
      expect(Buffer.byteLength(prompt)).toBeGreaterThan(128 * 1024);
      const result = await agent(prompt, { description: "long prompt" });
      expect(result.details.status).toBe("completed");
      expect(resultText(result).toLowerCase()).toContain("long");
      expect(userTexts(record(result.details.agentId).agent)).toEqual([prompt]);
    },
    5 * MINUTE,
  );

  test(
    "a read-only agent gets its tag and has no write tool",
    async () => {
      const result = await agent(
        "Two things. First, try to create the file b.txt with your write tool; do not use bash for it. Second, reply with the value of the name attribute of the active_agent tag in your system prompt, then say whether you had a write tool.",
        { readonly: true },
      );
      expect(result.details.status).toBe("completed");
      expect(resultText(result)).toContain("general-purpose");
      expect(existsSync(join(work, "b.txt"))).toBe(false);
    },
    5 * MINUTE,
  );

  test(
    "send_message steers a running turn, and the run ends on the steered reply",
    async () => {
      const from = pi.messages.length;
      const id = (await agent("Run `sleep 20` with bash and wait for it, then reply with the word done, unless I tell you otherwise.", { run_in_background: true })).details.agentId;
      await toolStarted(id);
      expect(resultText(await call("send_message", { to: id, message: "When the sleep ends, reply with the word steered instead of done, and nothing else." }))).toContain("is running");
      expect((await notice(from)).toLowerCase()).toContain("steered");
      expect(record(id).status).toBe("completed");
    },
    5 * MINUTE,
  );

  test(
    "stop_agent ends the child's process and its command, and a message right after resumes it without crashing the daemon",
    async () => {
      const marker = sleeper(4000);
      let from = pi.messages.length;
      const id = (await agent(`Run \`${marker}\` with bash and wait for it to finish.`, { run_in_background: true })).details.agentId;
      await waitFor(() => running(marker), 2 * MINUTE);
      expect((await call("stop_agent", { id })).details.status).toBe("stopped");

      from = pi.messages.length;
      await call("send_message", { to: id, message: "Do not run anything. Reply with the word resumed, and nothing else." });
      expect((await notice(from)).toLowerCase()).toContain("resumed");
      expect(record(id).status).toBe("completed");
      expect(running(marker)).toBe(false);
      expect(crashes()).toBe(0);

      await call("stop_agent", { id });
      expect(paseo("inspect", record(id).agent.paseoAgentId).Archived).toBe(true);
      expect(piOf(record(id).agent.paseoAgentId)).toBeUndefined();
    },
    5 * MINUTE,
  );

  test(
    "what a person types into a running agent ends the run stopped",
    async () => {
      const from = pi.messages.length;
      const id = (await agent("Run `sleep 60` with bash and wait for it, then reply with the word done.", { run_in_background: true })).details.agentId;
      await toolStarted(id);
      paseo("send", "--no-wait", record(id).agent.paseoAgentId, "--", "Stop that and reply with the word typed.");
      expect(await notice(from)).toContain("interrupted by input typed in Paseo");
      expect(record(id).status).toBe("stopped");
      expect(record(id).finalText.toLowerCase()).not.toContain("typed.");
    },
    5 * MINUTE,
  );

  test(
    "a child holds its run for its own background agent, which is a subagent of the child",
    async () => {
      const result = await agent(
        `Call the agent tool once, with run_in_background true, model "${MODEL}", effort "low", description "nested", and prompt "Reply with the word pineapple, and nothing else." Do not wait with bash. When its completion notice arrives, reply with the word it returned.`,
      );
      expect(result.details.status).toBe("completed");
      expect(resultText(result).toLowerCase()).toContain("pineapple");
      const { agent: identity } = record(result.details.agentId);
      const nested = readEntries(sessionFile(identity)).findLast((e) => e.type === "custom" && e.customType === "pstack-agents").data.agent;
      expect(paseo("inspect", nested.paseoAgentId).ParentAgentId).toBe(identity.paseoAgentId);
    },
    5 * MINUTE,
  );

  test(
    "a parent killed while its agent runs archives that agent when it is restored",
    async () => {
      const marker = sleeper(5000);
      const crashed = start(
        "pstack live crash parent",
        `Call the agent tool exactly once with run_in_background true, model "${MODEL}", effort "low", description "orphan", and prompt "Run \`${marker}\` with bash and wait for it to finish." Then reply with the single word started and stop. Do not wait for the agent.`,
      );
      await waitFor(() => running(marker), 2 * MINUTE);
      paseo("wait", crashed);
      const { id: child } = allAgents().find(({ name }) => name === "orphan");
      expect(paseo("inspect", child).ParentAgentId).toBe(crashed);

      process.kill(Number(piOf(crashed)), "SIGKILL");
      await waitFor(() => piOf(crashed) === undefined, MINUTE);
      expect(running(marker)).toBe(true);

      paseo("agent", "reload", crashed);
      await waitFor(() => paseo("inspect", child).Archived, MINUTE);
      await waitFor(() => !running(marker), MINUTE);
      paseo("send", "--no-wait", crashed, "--", "Call list_agents once and reply with only the status word of that agent.");
      const { message } = paseo("wait", crashed);
      expect(message.slice(message.lastIndexOf("[List agents]"))).toContain("stopped");
      expect(crashes()).toBe(0);
    },
    5 * MINUTE,
  );

  test(
    "the session's end archives its finished agents",
    async () => {
      const children = [...new Set(pi.entries.map((e) => e.data.agent.paseoAgentId).filter(Boolean))];
      expect(children.length).toBeGreaterThan(3);
      await pi.emit("session_shutdown", {}, ctx);
      expect(children.filter((id) => !paseo("inspect", id).Archived)).toEqual([]);
      expect(crashes()).toBe(0);
    },
    5 * MINUTE,
  );
});
