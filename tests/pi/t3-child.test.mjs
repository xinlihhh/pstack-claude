import { describe, expect, test } from "bun:test";

import { cancelTask, T3Child, t3Session } from "../../plugins/pstack/pi/t3-child.ts";
import { t3Reply as reply, useFakeT3 } from "./harness.mjs";

const SESSION = t3Session();
const fakeT3 = useFakeT3();
const failure = (message) => ({ content: [{ type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure", message }) }], isError: true });

const delegated = { taskId: "task-1", childThreadId: "thread-1", childRunId: "run-1" };

test("a first launch delegates to a T3 thread, waits until the run is settled, and returns its summary", async () => {
  let waits = 0;
  const { session, calls } = fakeT3({
    delegate_task: () => reply(delegated),
    t3_thread_wait: () => reply({ status: "completed", timedOut: ++waits < 2 }),
    task_status: () => reply({ status: "completed", summary: "the answer" }),
  });
  let started;
  const child = new T3Child(session, { title: "probe", model: "magpie/claude/claude-haiku-5-5", thinking: "low", onStart: (task) => (started = task) }, "do it");
  const exit = await child.exited;
  expect(exit).toEqual({ exitCode: 0, settled: true, finalText: "the answer", errorMessage: "", stderr: "" });
  expect(started).toEqual({ threadId: "thread-1", taskId: "task-1" });
  expect(calls.map((c) => c.name)).toEqual(["delegate_task", "t3_thread_wait", "t3_thread_wait", "task_status"]);
  expect(calls[0].args).toEqual({ task: "do it", title: "probe", target: { model: "magpie/claude/claude-haiku-5-5", options: { thinking: "low" } }, mode: "async" });
  expect(calls[1].args).toMatchObject({ threadId: "thread-1", runId: "run-1", untilDelegatedWorkSettled: true });
  expect(calls[3].args).toEqual({ taskId: "task-1" });
  expect(calls.every((c) => c.session === "s1" && c.auth === "Bearer tok")).toBe(true);
});

test("a resume sends to the agent's thread and a run that does not complete reports its status", async () => {
  const { session, calls } = fakeT3({
    t3_thread_send: () => reply({ taskId: "task-2", runId: "run-2", delivery: "started" }),
    t3_thread_wait: () => reply({ status: "failed", timedOut: false }),
    task_status: () => reply({ status: "failed", summary: null }),
  });
  const child = new T3Child(session, { title: "probe", threadId: "thread-1", onStart: () => {} }, "again");
  const exit = await child.exited;
  expect(exit).toMatchObject({ settled: false, finalText: "", errorMessage: "The T3 Code task ended with status failed." });
  expect(calls[0].args).toEqual({ threadId: "thread-1", message: "again", mode: "auto" });
  expect(calls[2].args).toEqual({ taskId: "task-2" });
});

test("a steer is taken only when T3 steers the running turn, and end cancels the task", async () => {
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  let steers = 0;
  const { session, calls } = fakeT3({
    delegate_task: () => reply(delegated),
    t3_thread_wait: async () => (await done, reply({ status: "interrupted", timedOut: false })),
    t3_thread_send: () => (++steers === 1 ? reply({ runId: "run-1", delivery: "steered" }) : failure("Thread has no running turn that can be steered.")),
    task_cancel: () => (finish(), reply({ taskId: "task-1", status: "cancel_requested" })),
    task_status: () => reply({ status: "interrupted", summary: "Child task ended with status interrupted." }),
  });
  const child = new T3Child(session, { title: "probe", onStart: () => {} }, "work");
  while (!calls.some((c) => c.name === "t3_thread_wait")) await Bun.sleep(5);
  expect(await child.steer("first")).toEqual({ response: { success: true }, taken: true });
  expect(await child.steer("second")).toEqual({ response: undefined, taken: false });
  expect(calls.filter((c) => c.name === "t3_thread_send").map((c) => c.args.mode)).toEqual(["steer", "steer"]);
  child.end();
  const exit = await child.exited;
  expect(exit).toMatchObject({ settled: false, errorMessage: "Child task ended with status interrupted." });
  expect(calls.find((c) => c.name === "task_cancel").args).toMatchObject({ taskId: "task-1" });
  expect(await child.steer("late")).toEqual({ response: undefined, taken: false });
});

test("a T3 error becomes the run's error message", async () => {
  const { session } = fakeT3({ delegate_task: () => failure("Provider instance is disabled.") });
  const exit = await new T3Child(session, { title: "probe", onStart: () => {} }, "x").exited;
  expect(exit.settled).toBe(false);
  expect(exit.errorMessage).toContain("Provider instance is disabled.");
});

const LIVE = process.env.PSTACK_PI_T3_LIVE === "1" && SESSION !== undefined;
const MODEL = process.env.PSTACK_PI_T3_MODEL;
const suite = LIVE ? describe : describe.skip;
const MINUTE = 60_000;

suite("T3Child on a live T3 Code server", () => {
  const launch = (prompt, threadId) => {
    const task = { threadId };
    const child = new T3Child(SESSION, { title: `pstack t3 live ${Date.now()}`, model: MODEL, thinking: "low", threadId, onStart: (started) => Object.assign(task, started) }, prompt);
    return { child, task };
  };

  test(
    "a run settles on its reply, and a resume in the same thread keeps the context",
    async () => {
      const first = launch("Remember the word t3probe42. Reply with the result of 6 * 7, and nothing else.");
      const exit = await first.child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.finalText).toContain("42");
      expect(first.task.threadId).toBeTruthy();
      const again = launch("Which word did I ask you to remember? Reply with just the word.", first.task.threadId);
      const resumed = await again.child.exited;
      expect(resumed.settled).toBe(true);
      expect(resumed.finalText).toContain("t3probe42");
    },
    5 * MINUTE,
  );

  test(
    "a steer reaches the running turn, and end stops a working run",
    async () => {
      const { child } = launch("Run `sleep 25` with bash and wait for it, then reply with the word done, unless I tell you otherwise.");
      await Bun.sleep(12_000);
      expect((await child.steer("When the sleep ends, reply with the word steered instead.")).taken).toBe(true);
      const steered = await child.exited;
      expect(steered.settled).toBe(true);
      expect(steered.finalText.toLowerCase()).toContain("steered");

      const long = launch("Run `sleep 120` with bash and wait for it, then say done.");
      await Bun.sleep(10_000);
      const at = Date.now();
      long.child.end();
      const stopped = await long.child.exited;
      expect(stopped.settled).toBe(false);
      expect(Date.now() - at).toBeLessThan(MINUTE);
    },
    5 * MINUTE,
  );

  test(
    "cancelTask, as a resumed session uses it, stops a working task and returns once its thread has settled",
    async () => {
      const { child, task } = launch("Run `sleep 120` with bash and wait for it, then say done.");
      await Bun.sleep(10_000);
      const at = Date.now();
      await cancelTask(SESSION, task.taskId, task.threadId);
      expect(Date.now() - at).toBeLessThan(MINUTE);
      expect((await child.exited).settled).toBe(false);
    },
    3 * MINUTE,
  );
});
