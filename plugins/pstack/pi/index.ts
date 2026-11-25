import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerAgentTools } from "./agent-tools.ts";
import { AgentRunner } from "./agents.ts";
import { registerAsk } from "./ask.ts";
import { activeAgentTag, DEPTH_FLAG, defaultSettings, type PstackHandoff, readSheet, type Settings, takeHandoff, withheldTools } from "./config.ts";
import { registerOneShot } from "./one-shot.ts";
import { INPUT_ENTRY, unwrapMessages } from "./paseo-child.ts";
import { registerPathSkills } from "./path-skills.ts";
import { registerPromptSections } from "./prompt.ts";
import { registerSchedule, Scheduler } from "./schedule.ts";

function registerPaseoChild(pi: ExtensionAPI, settings: Settings, handoff: PstackHandoff): void {
  const withheld = () => withheldTools(handoff.readonly, settings.depth);
  pi.on("input", (event) => {
    const { text, last } = unwrapMessages(event.text, handoff);
    if (last === undefined) return;
    pi.appendEntry(INPUT_ENTRY, { n: last });
    return { action: "transform", text };
  });
  pi.on("before_agent_start", (event) => {
    const names = withheld();
    if (names.length) pi.setActiveTools(pi.getActiveTools().filter((name) => !names.includes(name)));
    const body = handoff.systemPromptFile && readFileSync(handoff.systemPromptFile, "utf8");
    const added = [body, activeAgentTag(handoff.subagentType)].filter(Boolean).join("\n\n");
    const options = event.systemPromptOptions;
    // An extension loaded before this one, as Paseo's can be, may have replaced the whole prompt; the options then count for nothing.
    if (options.forceSystemPrompt !== undefined) return { systemPrompt: `${event.systemPrompt}\n\n${added}` };
    options.appendSystemPrompt = [options.appendSystemPrompt, added].filter(Boolean).join("\n\n");
  });
  // Also for a call made from a script, which the active tool list does not cover for every tool.
  pi.on("tool_call", (event) => (withheld().includes(event.toolName) ? { block: true, reason: `This agent has no ${event.toolName} tool.` } : undefined));
}

export function install(pi: ExtensionAPI, settings: Settings, handoff?: PstackHandoff): void {
  if (handoff) registerPaseoChild(pi, settings, handoff);
  const runner = new AgentRunner(pi, settings);
  const scheduler = new Scheduler();
  const oneShot = registerOneShot(pi, settings, runner);
  // Pi registers tools here, before any session directory is known, so these switches come from the directory Pi started in.
  const sheet = readSheet(settings.agentDir, process.cwd());
  if (!sheet?.agentToolsOff) registerAgentTools(pi, runner, settings);
  if (!sheet?.askToolOff) registerAsk(pi, oneShot);
  registerSchedule(pi, scheduler, oneShot);
  registerPromptSections(pi, settings);
  registerPathSkills(pi, settings);
  // Children run detached, in their own process group, so a parent that exits
  // without session_shutdown would leave them running: this exit hook signals
  // them, and each child pi then ends the bash command it has running.
  const onExit = () => runner.signalAll();
  process.on("exit", onExit);
  // Every entry, not the active branch: an agent started on a branch the user
  // later left is still a process, and its record is the only handle on it.
  pi.on("session_start", (_event, ctx) => {
    runner.attachSession(ctx);
    runner.restore(ctx.sessionManager.getEntries());
  });
  pi.on("session_shutdown", async () => {
    process.off("exit", onExit);
    oneShot.dispose();
    scheduler.stopAll();
    await runner.stopAll();
  });
}

const HANDOFF: unique symbol = Symbol.for("pstack.handoff");

export default function pstack(pi: ExtensionAPI): void {
  pi.registerFlag(DEPTH_FLAG, { type: "string", description: "Layers below the main session; pstack sets it on the agents it starts." });
  // Kept on globalThis: taking it empties the variable, and a session switch loads this extension again.
  const held = globalThis as { [HANDOFF]?: PstackHandoff };
  const handoff = (held[HANDOFF] ??= takeHandoff(process.env));
  install(pi, defaultSettings(() => Number(pi.getFlag(DEPTH_FLAG)) || 0, process.env.PI_CODING_AGENT_DIR, handoff), handoff);
}
