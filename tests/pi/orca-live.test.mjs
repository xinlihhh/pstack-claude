// The orca host against a real Orca runtime and a real model. Skipped unless
// PSTACK_PI_ORCA_LIVE=1. It starts an `orca-ide serve` of its own, with a
// throwaway HOME and ORCA_USER_DATA_PATH on 127.0.0.1, and at the end stops only
// the processes whose environment names that data path, so the user's Orca is
// never touched. Never run a bare `orca` here: on Linux it is a screen reader.
// PSTACK_PI_ORCA_MODEL picks the model; ORCA_IDE the server CLI.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { sessionFile } from "../../plugins/pstack/pi/agents.ts";
import { alive } from "../../plugins/pstack/pi/child.ts";
import { OrcaChild } from "../../plugins/pstack/pi/orca-child.ts";
import { readEntries } from "./harness.mjs";

const LIVE = process.env.PSTACK_PI_ORCA_LIVE === "1";
const MODEL = process.env.PSTACK_PI_ORCA_MODEL ?? "magpie/claude/claude-haiku-5-5";
const ORCA_IDE = process.env.ORCA_IDE ?? join(homedir(), ".local", "bin", "orca-ide");
const USER_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const MINUTE = 60_000;
const GRACE = 5_000;
const suite = LIVE ? describe : describe.skip;

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const until = async (predicate, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(500)) if (predicate()) return true;
  return predicate();
};

suite("the orca host on a live Orca runtime", () => {
  let root;
  let data;
  let serveEnv;
  let session;
  let work;
  let agentDir;

  const ours = (pid) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`ORCA_USER_DATA_PATH=${data}`);
    } catch {
      return false;
    }
  };

  function orca(...args) {
    const run = spawnSync(session?.cli ?? ORCA_IDE, [...args, "--json"], { encoding: "utf8", env: serveEnv, timeout: 2 * MINUTE });
    const answer = JSON.parse(run.stdout || "{}");
    if (run.status !== 0 || answer.ok === false) throw new Error(`orca ${args.join(" ")} failed: ${run.stderr}${run.stdout}`);
    return answer.result;
  }
  const terminals = () => orca("terminal", "list", `--worktree=id:${session.workspace}`).terminals;
  const userTexts = (identity) => readEntries(sessionFile(identity)).filter((e) => e.type === "message" && e.message.role === "user");
  const toolStarted = (identity) =>
    until(() => {
      const file = sessionFile(identity);
      return Boolean(file) && readEntries(file).some((e) => e.type === "message" && e.message.role === "assistant" && e.message.content.some((c) => c.type === "toolCall"));
    }, 2 * MINUTE);

  function launch(prompt, { args = [], env = {}, identity } = {}) {
    identity ??= { id: `a${randomUUID().slice(0, 8)}`, sessionDir: join(root, "agents"), sessionId: randomUUID() };
    mkdirSync(identity.sessionDir, { recursive: true });
    const started = {};
    const child = new OrcaChild(
      "pi",
      ["--session-id", identity.sessionId, "--session-dir", identity.sessionDir, "--model", MODEL, "--thinking", "low", "--approve", ...args],
      {
        session,
        title: `pstack live ${identity.id}`,
        cwd: work,
        env: { PI_CODING_AGENT_DIR: agentDir, ...env },
        files: join(identity.sessionDir, identity.id),
        graceMs: GRACE,
        transcript: () => sessionFile(identity),
        onStart: (pid) => {
          started.pid = pid;
        },
      },
      prompt,
    );
    return { child, identity, started };
  }

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pstack-orca-live-")));
    const home = join(root, "home");
    data = join(root, "data");
    agentDir = join(root, "agent");
    work = join(root, "work");
    for (const dir of [home, data, join(agentDir, "extensions"), work]) mkdirSync(dir, { recursive: true });
    for (const file of ["auth.json", "models.json"]) if (existsSync(join(USER_AGENT_DIR, file))) symlinkSync(join(USER_AGENT_DIR, file), join(agentDir, file));
    const status = join(USER_AGENT_DIR, "extensions", "orca-agent-status.ts");
    if (existsSync(status)) copyFileSync(status, join(agentDir, "extensions", "orca-agent-status.ts"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true }));
    for (const name of Object.keys(process.env)) if (/^(ORCA|PI|T3|HC|PASEO)_/.test(name)) delete process.env[name];
    process.env.PI_TELEMETRY = "0";

    spawnSync("git", ["init", "-q", "-b", "main", work]);
    spawnSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
    writeFileSync(join(work, "a.txt"), "1\n2\n3\n");

    const { USER, LOGNAME, SHELL, LANG, XDG_RUNTIME_DIR, PATH } = process.env;
    serveEnv = { HOME: home, USER, LOGNAME, SHELL, LANG, XDG_RUNTIME_DIR, PATH, ORCA_USER_DATA_PATH: data };
    const port = await freePort();
    spawn(ORCA_IDE, ["serve", "--port", String(port), "--bind", "127.0.0.1", "--no-pairing", "--json"], { cwd: root, env: serveEnv, detached: true, stdio: "ignore" }).unref();
    const ready = await until(() => {
      try {
        return orca("status").runtime.state === "ready";
      } catch {
        return false;
      }
    }, MINUTE);
    if (!ready) throw new Error("the isolated orca-ide serve did not become ready");
    const cli = join(data, "cli", "bin", "orca");
    if (!readFileSync(cli, "utf8").includes(`ORCA_USER_DATA_PATH='${data}'`)) throw new Error(`refusing to run ${cli}: it does not pin ${data}`);
    orca("repo", "add", `--path=${work}`);
    const workspace = orca("worktree", "list").worktrees.find((w) => w.path === work).id;
    session = { cli, workspace };
    console.log(`isolated orca runtime on 127.0.0.1:${port}, data ${data}`);
  }, 2 * MINUTE);

  afterAll(async () => {
    if (session) {
      try {
        orca("terminal", "close", `--worktree=id:${session.workspace}`, "--all");
      } catch {}
    }
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p) && ours(p))) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {}
    }
    await until(() => !readdirSync("/proc").some((p) => /^\d+$/.test(p) && ours(p)), 30_000);
    if (root) rmSync(root, { recursive: true });
  }, MINUTE);

  test(
    "a run settles on the reply in its transcript, in a tab Orca lists with the agent's title, with the parent's environment off argv and its files removed",
    async () => {
      process.env.PSTACK_ORCA_PROBE = "orcaprobe42";
      const { child, identity, started } = launch("Run `wc -l a.txt` and `echo $PSTACK_ORCA_PROBE` with bash, then try the write tool on b.txt. Reply with the line count, the echoed word, and whether write existed.", {
        args: ["--exclude-tools", "edit,write"],
      });
      delete process.env.PSTACK_ORCA_PROBE;
      await until(() => started.pid !== undefined, MINUTE);
      expect(readFileSync(`/proc/${started.pid}/cmdline`, "utf8")).not.toContain("orcaprobe42");
      expect(await until(() => orca("agent", "list").agents.some((a) => a.title === `pstack live ${identity.id}`), MINUTE)).toBe(true);
      const exit = await child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.errorMessage).toBe("");
      expect(exit.finalText).toContain("3");
      expect(exit.finalText).toContain("orcaprobe42");
      expect(existsSync(join(work, "b.txt"))).toBe(false);
      for (const ext of [".env", ".prompt", ".sh"]) expect(existsSync(join(identity.sessionDir, `${identity.id}${ext}`))).toBe(false);
      expect(alive(started.pid)).toBe(false);
      expect(await until(() => terminals().length === 0, 10_000)).toBe(true);
    },
    5 * MINUTE,
  );

  test(
    "a prompt that starts with a dash or an @, with quotes, $, and backticks across lines, reaches the child as written",
    async () => {
      for (const lead of ["--help is not a flag.", "@a.txt is not a file argument."]) {
        const prompt = `${lead} Quote test: "dq" 'sq' & <b> $HOME \`id\`\nSecond line. Reply with the word verbatim, and nothing else.`;
        const { child, identity } = launch(prompt);
        const exit = await child.exited;
        expect(exit.settled).toBe(true);
        expect(exit.finalText.toLowerCase()).toContain("verbatim");
        expect(userTexts(identity)[0].message.content[0].text.trim()).toBe(prompt);
      }
    },
    5 * MINUTE,
  );

  test(
    "a long multi-line steer reaches a working child in the same turn, and the run ends on the steered reply",
    async () => {
      const { child, identity } = launch("Run `sleep 20` with bash and wait for it, then reply with the word done, unless I tell you otherwise.");
      expect(await toolStarted(identity)).toBe(true);
      const filler = Array.from({ length: 150 }, (_, i) => `filler line ${i} "q" & $HOME`).join("\n");
      const steer = `When the sleep ends, reply with the word steered instead, and nothing else.\n${filler}`;
      expect((await child.steer(steer)).taken).toBe(true);
      const exit = await child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.finalText.toLowerCase()).toContain("steered");
      const users = userTexts(identity);
      expect(users.length).toBe(2);
      expect(users[1].message.content[0].text).toContain("filler line 149");
    },
    5 * MINUTE,
  );

  test(
    "a steer sent as soon as the tab starts, before pi has drawn its screen, is not lost",
    async () => {
      const { child, identity, started } = launch("Run `sleep 5` with bash and wait for it, then reply with the word done, unless I tell you otherwise.");
      await until(() => started.pid !== undefined, MINUTE);
      await until(() => existsSync(`/proc/${started.pid}`), 5_000);
      expect((await child.steer("When the sleep ends, reply with the word early instead, and nothing else.")).taken).toBe(true);
      const exit = await child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.finalText.toLowerCase()).toContain("early");
      expect(userTexts(identity).length).toBe(2);
    },
    5 * MINUTE,
  );

  test(
    "end stops a working run and the command it runs within the grace period, and its tab goes",
    async () => {
      const marker = `sleep ${900 + Math.floor(Math.random() * 99)}`;
      const { child, identity, started } = launch(`Run \`${marker}\` with bash and wait for it to finish, then say done.`);
      expect(await toolStarted(identity)).toBe(true);
      const running = () => spawnSync("pgrep", ["-f", `^${marker}$`]).status === 0;
      expect(await until(running, 30_000)).toBe(true);
      const at = Date.now();
      child.end(GRACE);
      const exit = await child.exited;
      expect(exit.settled).toBe(false);
      expect(Date.now() - at).toBeLessThan(GRACE + 10_000);
      expect(alive(started.pid)).toBe(false);
      expect(await until(() => !running(), 10_000)).toBe(true);
      expect(await until(() => terminals().length === 0, 10_000)).toBe(true);
    },
    5 * MINUTE,
  );

  test(
    "Escape typed into the tab during a tool call ends the run as stopped in Orca",
    async () => {
      const { child, identity } = launch("Run `sleep 30` with bash and wait for it, then reply with the word done.");
      expect(await toolStarted(identity)).toBe(true);
      const tab = terminals()[0].handle;
      orca("terminal", "send", `--terminal=${tab}`, "--text=\u001b");
      const exit = await child.exited;
      expect(exit.interruption).toBe("stopped in Orca");
      expect(await until(() => terminals().length === 0, 10_000)).toBe(true);
    },
    5 * MINUTE,
  );

  test(
    "a second run on the same session id resumes the conversation in a new tab",
    async () => {
      const first = launch("Remember the word marmalade. Reply with the word noted, and nothing else.");
      expect((await first.child.exited).settled).toBe(true);
      const second = launch("Which word did I ask you to remember? Reply with that word only.", { identity: first.identity });
      const exit = await second.child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.finalText.toLowerCase()).toContain("marmalade");
      expect(readdirSync(first.identity.sessionDir).filter((n) => n.endsWith(`_${first.identity.sessionId}.jsonl`)).length).toBe(1);
    },
    5 * MINUTE,
  );
});
