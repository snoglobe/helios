import type React from "react";
import type { Orchestrator } from "../core/orchestrator.js";
import type { ConnectionPool } from "../remote/connection-pool.js";
import type { RemoteExecutor } from "../remote/executor.js";
import type { MetricStore } from "../metrics/store.js";
import type { MetricCollector } from "../metrics/collector.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { StickyManager, StickyNote } from "../core/stickies.js";
import type { ReasoningEffort } from "../providers/types.js";
import type { SessionSummary } from "../store/session-store.js";
import type { Message } from "./types.js";
import { formatError, formatMetricValue } from "./format.js";
import { sparkline } from "./panels/metrics-dashboard.js";
import { ClaudeProvider } from "../providers/claude/provider.js";
import { savePreferences } from "../store/preferences.js";
import {
  loadMachines,
  addMachine as addMachineConfig,
  removeMachine as removeMachineConfig,
  parseMachineSpec,
} from "../remote/config.js";
import {
  loadHubConfig,
  saveHubConfig,
  removeHubConfig,
} from "../hub/config.js";
import { HubClient } from "../hub/client.js";
import { createHubTools } from "../tools/hub.js";
import { buildWriteupSystemPrompt } from "../tools/writeup.js";

// ─── Types ────────────────────────────────────────────

export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
}

export interface CommandContext {
  orchestrator: Orchestrator;
  addMessage: (role: Message["role"], content: string) => number;
  updateMessage: (id: number, updates: Partial<Message>) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  messages: Message[];
  setIsStreaming: (v: boolean) => void;
  connectionPool?: ConnectionPool;
  metricStore?: MetricStore;
  metricCollector?: MetricCollector;
  memoryStore?: MemoryStore;
  stickyManager?: StickyManager;
  setStickyNotes?: React.Dispatch<React.SetStateAction<StickyNote[]>>;
  executor?: RemoteExecutor;
  /** Build Message[] from stored messages (needs access to the id counter). */
  restoreMessages: (messages: Array<{ role: string; content: string }>) => Message[];
}

// ─── Command Registry ─────────────────────────────────

/**
 * Single source of truth for all slash commands.
 * Autocomplete (input-bar), /help text, and dispatch all derive from this.
 */
export const COMMANDS: SlashCommand[] = [
  { name: "help", description: "Show available commands and keybindings" },
  { name: "switch", args: "<claude|openai>", description: "Switch model provider" },
  { name: "model", args: "<model-id>", description: "Set model (e.g. gpt-5.4, claude-opus-4-6)" },
  { name: "models", description: "List available models for current provider" },
  { name: "reasoning", args: "<level>", description: "Set reasoning effort (none/low/medium/high/max)" },
  { name: "claude-mode", args: "<cli|api>", description: "Switch Claude auth mode (cli = Agent SDK, api = API key)" },
  { name: "resume", args: "[number]", description: "List or resume a past session" },
  { name: "metric", args: "[name1 name2 ...]", description: "Show sparklines for named metrics" },
  { name: "metrics", args: "clear", description: "Clear all collected metrics" },
  { name: "writeup", description: "Generate an experiment writeup from the session" },
  { name: "machine", args: "<add|rm|list>", description: "Manage remote machines" },
  { name: "machines", description: "List configured remote machines" },
  { name: "hub", args: "[connect|disconnect|status]", description: "AgentHub collaboration (self-register)" },
  { name: "sticky", args: "<text>", description: "Pin a sticky note (always visible to the model)" },
  { name: "stickies", args: "[rm <num>]", description: "List sticky notes, or remove one by number" },
  { name: "memory", args: "[path]", description: "Show the memory tree (virtual filesystem)" },
  { name: "status", description: "Show provider, model, state, and cost" },
  { name: "clear", description: "Clear conversation history" },
  { name: "quit", description: "Exit Helios" },
];

/** Format COMMANDS into the /help text block. */
export function formatHelpText(): string {
  const maxLen = COMMANDS.reduce((max, cmd) => {
    const full = `  /${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
    return Math.max(max, full.length);
  }, 0);

  const lines = COMMANDS.map((cmd) => {
    const full = `  /${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
    return `${full.padEnd(maxLen + 2)}${cmd.description}`;
  });

  return [
    "Commands:",
    ...lines,
    "",
    "Keys:",
    "  Tab        Autocomplete command",
    "  ↑↓         Navigate menu / history",
    "  ←→         Move cursor",
    "  Ctrl+T     Task output overlay",
    "  Ctrl+G     Metrics overlay",
    "  Escape     Interrupt / close overlay",
    "  Ctrl+A/E   Start / end of line",
    "  Ctrl+W     Delete word backward",
    "  Ctrl+U     Clear line",
    "  Ctrl+C     Interrupt / Exit",
  ].join("\n");
}

// ─── Dispatch ─────────────────────────────────────────

export async function handleSlashCommand(
  input: string,
  ctx: CommandContext,
): Promise<void> {
  const parts = input.slice(1).split(" ");
  const cmd = parts[0];
  const args = parts.slice(1);

  switch (cmd) {
    case "switch":
      cmdSwitch(args, ctx);
      break;
    case "model":
      cmdModel(args, ctx);
      break;
    case "reasoning":
      cmdReasoning(args, ctx);
      break;
    case "models":
      cmdModels(ctx);
      break;
    case "claude-mode":
      cmdClaudeMode(args, ctx);
      break;
    case "machine":
    case "machines":
      cmdMachine(args, ctx);
      break;
    case "resume":
      cmdResume(args, ctx);
      break;
    case "metric":
    case "metrics":
      cmdMetric(args, ctx);
      break;
    case "writeup":
      await cmdWriteup(ctx);
      break;
    case "help":
      ctx.addMessage("system", formatHelpText());
      break;
    case "status":
      cmdStatus(ctx);
      break;
    case "sticky":
      cmdSticky(args, ctx);
      break;
    case "stickies":
      cmdStickies(args, ctx);
      break;
    case "memory":
      cmdMemory(args, ctx);
      break;
    case "hub":
      cmdHub(args, ctx);
      break;
    case "clear":
      ctx.setMessages([]);
      break;
    case "quit":
    case "exit":
      process.exit(0);
      break;
    default:
      ctx.addMessage("system", `Unknown command: /${cmd}. Try /help`);
  }
}

// ─── Command Implementations ──────────────────────────

function cmdSwitch(args: string[], ctx: CommandContext): void {
  const { orchestrator, addMessage } = ctx;
  const provider = args[0] as "claude" | "openai" | undefined;
  if (provider !== "claude" && provider !== "openai") {
    addMessage("system", "Usage: /switch <claude|openai>");
    return;
  }
  addMessage("system", `Switching to ${provider}...`);
  orchestrator.switchProvider(provider).then(
    () => addMessage("system", `Switched to ${provider}`),
    (err) => addMessage("error", `Failed to switch: ${formatError(err)}`),
  );
}

function cmdModel(args: string[], ctx: CommandContext): void {
  const { orchestrator, addMessage } = ctx;
  const modelId = args[0];
  if (!modelId) {
    addMessage(
      "system",
      `Current model: ${orchestrator.currentModel ?? "default"}\nUsage: /model <model-id>`,
    );
    return;
  }
  addMessage("system", `Setting model to ${modelId}...`);
  orchestrator.setModel(modelId).then(
    () => {
      savePreferences({ model: modelId });
      addMessage("system", `Model set to ${modelId}`);
    },
    (err) => addMessage("error", `Failed to set model: ${formatError(err)}`),
  );
}

function cmdReasoning(args: string[], ctx: CommandContext): void {
  const { orchestrator, addMessage } = ctx;
  const level = args[0];
  const validLevels = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  if (!level || !validLevels.includes(level)) {
    const provider = orchestrator.currentProvider?.name;
    const hint =
      provider === "claude"
        ? "Claude: medium, high, max"
        : "OpenAI: none, minimal, low, medium, high, xhigh";
    addMessage(
      "system",
      `Current reasoning effort: ${orchestrator.reasoningEffort ?? "medium"}\n${hint}\nUsage: /reasoning <level>`,
    );
    return;
  }
  orchestrator.setReasoningEffort(level as ReasoningEffort).then(
    () => {
      savePreferences({ reasoningEffort: level });
      addMessage("system", `Reasoning effort set to ${level}`);
    },
    (err) => addMessage("error", `Failed: ${formatError(err)}`),
  );
}

function cmdModels(ctx: CommandContext): void {
  const { orchestrator, addMessage } = ctx;
  addMessage("system", "Fetching available models...");
  orchestrator.fetchModels().then(
    (models) => {
      const current = orchestrator.currentModel;
      const lines = models.map((m) => {
        const marker = m.id === current ? " ◆" : "";
        const desc = m.description ? ` — ${m.description}` : "";
        return `  ${m.id}${marker}${desc}`;
      });
      addMessage("system", `Available models:\n${lines.join("\n")}`);
    },
    (err) => addMessage("error", `Failed to fetch models: ${formatError(err)}`),
  );
}

function cmdClaudeMode(args: string[], ctx: CommandContext): void {
  const { orchestrator, addMessage } = ctx;
  const mode = args[0];
  if (mode !== "cli" && mode !== "api") {
    const current = (
      orchestrator.getProvider("claude") as ClaudeProvider | null
    )?.currentAuthMode;
    addMessage(
      "system",
      `Current Claude mode: ${current === "cli" ? "cli (Agent SDK)" : "api (API key)"}\nUsage: /claude-mode <cli|api>`,
    );
    return;
  }
  const claude = orchestrator.getProvider("claude") as ClaudeProvider | null;
  if (!claude) {
    addMessage("error", "Claude provider not registered");
    return;
  }
  claude.setPreferredAuthMode(mode);
  savePreferences({ claudeAuthMode: mode });
  claude.authenticate().then(
    () =>
      addMessage(
        "system",
        `Claude mode set to ${mode === "cli" ? "cli (Agent SDK)" : "api (API key)"}`,
      ),
    (err) =>
      addMessage(
        "error",
        `Failed to switch Claude mode: ${formatError(err)}`,
      ),
  );
}

function cmdMachine(args: string[], ctx: CommandContext): void {
  const { addMessage, connectionPool } = ctx;
  const subCmd = args[0];

  if (!subCmd || subCmd === "list") {
    const machines = loadMachines();
    if (machines.length === 0) {
      addMessage(
        "system",
        "No machines configured.\nUsage: /machine add <id> <user@host[:port]> [--key <path>]",
      );
      return;
    }
    const lines = machines.map((m) => {
      const status = connectionPool?.getStatus(m.id);
      let statusText = status?.connected
        ? "◆ connected"
        : "◇ disconnected";
      if (!status?.connected && status?.error) {
        statusText += ` — ${status.error}`;
      }
      return `  ${m.id}  ${m.username}@${m.host}:${m.port}  [${m.authMethod}]  ${statusText}`;
    });
    addMessage("system", `Machines:\n${lines.join("\n")}`);
    return;
  }

  if (subCmd === "add") {
    const id = args[1];
    const spec = args[2];
    if (!id || !spec) {
      addMessage(
        "system",
        "Usage: /machine add <id> <user@host[:port]> [--key <path>]",
      );
      return;
    }

    const options: { key?: string; auth?: string } = {};
    for (let i = 3; i < args.length; i++) {
      if (args[i] === "--key" && args[i + 1]) {
        options.key = args[++i];
      } else if (args[i] === "--auth" && args[i + 1]) {
        options.auth = args[++i];
      }
    }

    try {
      const machine = parseMachineSpec(id, spec, options);
      addMachineConfig(machine);
      connectionPool?.addMachine(machine);
      addMessage(
        "system",
        `Added machine "${id}" (${machine.username}@${machine.host}:${machine.port}). Connecting...`,
      );
      connectionPool?.connect(id).then(
        () => addMessage("system", `Machine "${id}" connected ◆`),
        (err) =>
          addMessage(
            "error",
            `Machine "${id}" added but connection failed: ${formatError(err)}\nThe agent can still try to connect later.`,
          ),
      );
    } catch (err) {
      addMessage("error", `Failed to add machine: ${formatError(err)}`);
    }
    return;
  }

  if (subCmd === "rm" || subCmd === "remove") {
    const id = args[1];
    if (!id) {
      addMessage("system", "Usage: /machine rm <id>");
      return;
    }
    if (removeMachineConfig(id)) {
      connectionPool?.removeMachine(id);
      addMessage("system", `Removed machine "${id}"`);
    } else {
      addMessage("error", `Machine "${id}" not found`);
    }
    return;
  }

  addMessage("system", "Usage: /machine <add|rm|list>");
}

// Stash session listing so /resume <n> can look up by index
let lastSessionListing: SessionSummary[] = [];

function cmdResume(args: string[], ctx: CommandContext): void {
  const { orchestrator, addMessage, setMessages, restoreMessages } = ctx;
  const index = args[0] ? Number.parseInt(args[0], 10) : NaN;

  if (Number.isNaN(index)) {
    const sessions = orchestrator.sessionStore.listSessionSummaries(20);
    if (sessions.length === 0) {
      addMessage("system", "No past sessions found.");
      return;
    }
    lastSessionListing = sessions;

    const lines = sessions.map((s, i) => {
      const date = new Date(s.lastActiveAt).toLocaleString();
      const provider = s.provider;
      const preview = s.firstUserMessage ?? "(no messages)";
      const msgs = `${s.messageCount} msg${s.messageCount !== 1 ? "s" : ""}`;
      return `  ${i + 1}. [${date}] ${provider} (${msgs})\n     ${preview}`;
    });

    addMessage(
      "system",
      `Recent sessions:\n${lines.join("\n")}\n\nUse /resume <number> to resume a session.`,
    );
    return;
  }

  if (index < 1 || index > lastSessionListing.length) {
    addMessage(
      "system",
      lastSessionListing.length === 0
        ? "Run /resume first to list sessions."
        : `Invalid index. Choose 1-${lastSessionListing.length}.`,
    );
    return;
  }

  const target = lastSessionListing[index - 1];
  addMessage(
    "system",
    `Resuming session from ${new Date(target.lastActiveAt).toLocaleString()}...`,
  );

  const storedMessages = orchestrator.sessionStore.getMessages(target.id, 500);
  const restored = restoreMessages(
    storedMessages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content })),
  );
  setMessages(restored);

  orchestrator.resumeSession(target.id).then(
    () =>
      addMessage(
        "system",
        `Session resumed (${target.provider}, ${storedMessages.length} messages loaded)`,
      ),
    (err) =>
      addMessage("error", `Failed to resume session: ${formatError(err)}`),
  );
}

function cmdMetric(args: string[], ctx: CommandContext): void {
  const { addMessage, metricStore, metricCollector } = ctx;
  if (!metricStore) {
    addMessage("error", "Metric store not available");
    return;
  }

  if (args[0] === "clear") {
    const deleted = metricStore.clear();
    metricCollector?.reset();
    addMessage("system", `Cleared ${deleted} metric points.`);
  } else if (args.length === 0) {
    const allNames = metricStore.getAllMetricNames();
    if (allNames.length === 0) {
      addMessage("system", "No metrics recorded yet.");
    } else {
      addMessage(
        "system",
        `Known metrics:\n  ${allNames.join("  ")}\n\nUsage: /metric <name1> [name2] ... | /metrics clear`,
      );
    }
  } else {
    const lines: string[] = [];
    for (const name of args) {
      const series = metricStore.getSeriesAcrossTasks(name, 50);
      if (series.length === 0) {
        lines.push(`  ${name}  (no data)`);
        continue;
      }
      const values = series.map((p) => p.value);
      const latest = values[values.length - 1];
      const min = Math.min(...values);
      const max = Math.max(...values);
      const spark = sparkline(values, 30);
      lines.push(
        `  ${name}  ${spark}  ${formatMetricValue(latest)}  (min ${formatMetricValue(min)} max ${formatMetricValue(max)})`,
      );
    }
    addMessage("system", lines.join("\n"));
  }
}

function cmdStatus(ctx: CommandContext): void {
  const { orchestrator, addMessage } = ctx;
  addMessage(
    "system",
    [
      `Provider: ${orchestrator.currentProvider?.displayName ?? "None"}`,
      `Model: ${orchestrator.currentModel ?? "default"}`,
      `Reasoning: ${orchestrator.reasoningEffort ?? "medium"}`,
      `State: ${orchestrator.currentState}`,
      `Cost: $${orchestrator.totalCostUsd.toFixed(4)}`,
    ].join("\n"),
  );
}

function cmdSticky(args: string[], ctx: CommandContext): void {
  const { addMessage, stickyManager, setStickyNotes } = ctx;
  if (!stickyManager || !setStickyNotes) {
    addMessage("system", "Sticky notes not available.");
    return;
  }
  const stickyText = args.join(" ").trim();
  if (!stickyText) {
    addMessage("system", "Usage: /sticky <text to pin>");
    return;
  }
  const note = stickyManager.add(stickyText);
  setStickyNotes(stickyManager.list());
  addMessage("system", `Pinned sticky #${note.num}: ${stickyText}`);
}

function cmdStickies(args: string[], ctx: CommandContext): void {
  const { addMessage, stickyManager, setStickyNotes } = ctx;
  if (!stickyManager || !setStickyNotes) {
    addMessage("system", "Sticky notes not available.");
    return;
  }
  if (args[0] === "rm" && args[1]) {
    const num = parseInt(args[1], 10);
    if (isNaN(num)) {
      addMessage("system", "Usage: /stickies rm <number>");
      return;
    }
    const removed = stickyManager.remove(num);
    setStickyNotes(stickyManager.list());
    addMessage(
      "system",
      removed ? `Removed sticky #${num}` : `Sticky #${num} not found`,
    );
  } else {
    const notes = stickyManager.list();
    if (notes.length === 0) {
      addMessage("system", "No sticky notes. Use /sticky <text> to add one.");
    } else {
      const listing = notes
        .map((n) => `  [${n.num}] ${n.text}`)
        .join("\n");
      addMessage("system", `Sticky notes:\n${listing}`);
    }
  }
}

function cmdMemory(args: string[], ctx: CommandContext): void {
  const { addMessage, memoryStore } = ctx;
  if (!memoryStore) {
    addMessage("system", "Memory system not initialized.");
    return;
  }
  const memPath = args[0] ?? "/";
  const tree = memoryStore.formatTree(memPath);
  addMessage("system", `Memory tree (${memPath}):\n${tree}`);
}

function cmdHub(args: string[], ctx: CommandContext): void {
  const { addMessage, orchestrator, executor } = ctx;
  const subCmd = args[0];

  if (!subCmd || subCmd === "status") {
    const config = loadHubConfig();
    if (!config) {
      addMessage(
        "system",
        "AgentHub not configured.\nUsage: /hub connect <url> [agent-name]",
      );
    } else {
      const client = new HubClient(config);
      addMessage(
        "system",
        `AgentHub: ${config.url}\nAgent: ${config.agentName ?? "(unnamed)"}\nChecking connection...`,
      );
      client.health().then(
        () => addMessage("system", "AgentHub connection OK"),
        (err) =>
          addMessage("error", `AgentHub unreachable: ${formatError(err)}`),
      );
    }
    return;
  }

  if (subCmd === "connect") {
    const url = args[1];
    const agentName =
      args[2] ?? `helios-${Math.random().toString(36).slice(2, 8)}`;
    if (!url) {
      addMessage(
        "system",
        "Usage: /hub connect <url> [agent-name]",
      );
      return;
    }

    const cleanUrl = (url.startsWith("http://") || url.startsWith("https://") ? url : `http://${url}`).replace(/\/+$/, "");
    addMessage(
      "system",
      `Registering "${agentName}" on ${cleanUrl}...`,
    );

    HubClient.selfRegister(cleanUrl, agentName).then(
      (result) => {
        const config = {
          url: cleanUrl,
          apiKey: result.api_key,
          agentName: result.id,
        };
        saveHubConfig(config);

        if (executor) {
          const client = new HubClient(config);
          orchestrator.registerTools(createHubTools(client, executor));
          addMessage(
            "system",
            `Registered as "${result.id}" on ${cleanUrl}\nHub tools are now available.`,
          );
        } else {
          addMessage(
            "system",
            `Registered as "${result.id}". Restart Helios to activate hub tools.`,
          );
        }
      },
      (err) =>
        addMessage("error", `Registration failed: ${formatError(err)}`),
    );
    return;
  }

  if (subCmd === "disconnect") {
    removeHubConfig();
    addMessage(
      "system",
      "AgentHub config removed. Restart Helios to remove hub tools.",
    );
    return;
  }

  addMessage(
    "system",
    "Usage: /hub [connect <url> [name] | disconnect | status]",
  );
}

async function cmdWriteup(ctx: CommandContext): Promise<void> {
  const { orchestrator, messages, addMessage, updateMessage, setIsStreaming } =
    ctx;

  if (messages.length === 0) {
    addMessage("system", "No conversation to write up.");
    return;
  }

  const transcript = messages
    .map((m) => {
      if (m.role === "user") return `[USER] ${m.content}`;
      if (m.role === "assistant") return `[ASSISTANT] ${m.content}`;
      if (m.role === "tool" && m.tool) {
        const result = m.tool.result ? `\nResult: ${m.tool.result}` : "";
        return `[TOOL: ${m.tool.name}] ${JSON.stringify(m.tool.args)}${result}`;
      }
      if (m.role === "system") return `[SYSTEM] ${m.content}`;
      if (m.role === "error") return `[ERROR] ${m.content}`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  addMessage("system", "Generating writeup...");
  setIsStreaming(true);

  try {
    const provider = orchestrator.currentProvider;
    if (!provider) {
      addMessage("error", "No active provider");
      return;
    }

    const writeupSession = await provider.createSession({
      systemPrompt: buildWriteupSystemPrompt({ transcript: true }),
    });

    try {
      let writeupText = "";
      let writeupMsgId: number | null = null;

      for await (const event of provider.send(
        writeupSession,
        `Here is the full experiment session transcript:\n\n${transcript}`,
        [],
      )) {
        if (event.type === "text" && event.delta) {
          writeupText += event.delta;
          if (writeupMsgId === null) {
            writeupMsgId = addMessage("assistant", writeupText);
          } else {
            updateMessage(writeupMsgId, { content: writeupText });
          }
        }
      }
    } finally {
      await provider.closeSession(writeupSession).catch(() => {});
    }
  } catch (err) {
    addMessage("error", `Writeup failed: ${formatError(err)}`);
  } finally {
    setIsStreaming(false);
  }
}
