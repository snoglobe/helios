/**
 * Shared runtime initialization for both TUI and ACP modes.
 * Extracted from app.tsx to avoid duplication.
 */

import { AuthManager } from "./providers/auth/auth-manager.js";
import { OpenAIOAuth } from "./providers/openai/oauth.js";
import { ClaudeProvider } from "./providers/claude/provider.js";
import { OpenAIProvider } from "./providers/openai/provider.js";
import { ConnectionPool } from "./remote/connection-pool.js";
import { RemoteExecutor } from "./remote/executor.js";
import { FileSync } from "./remote/file-sync.js";
import { MetricStore } from "./metrics/store.js";
import { MetricCollector } from "./metrics/collector.js";
import { MemoryStore } from "./memory/memory-store.js";
import { ContextGate } from "./memory/context-gate.js";
import { ExperimentTracker } from "./memory/experiment-tracker.js";
import { StickyManager } from "./core/stickies.js";
import { Orchestrator } from "./core/orchestrator.js";
import { TriggerScheduler } from "./scheduler/trigger-scheduler.js";
import { SleepManager } from "./scheduler/sleep-manager.js";
import { MonitorManager } from "./core/monitor.js";
import { loadHubConfig } from "./hub/config.js";
import { HubClient } from "./hub/client.js";
import { formatError } from "./ui/format.js";
import { loadMachines } from "./remote/config.js";
import { loadPreferences } from "./store/preferences.js";
import { SessionStore } from "./store/session-store.js";
import {
  createRemoteExecTool,
  createRemoteExecBackgroundTool,
} from "./tools/remote-exec.js";
import {
  createUploadTool,
  createDownloadTool,
} from "./tools/remote-sync.js";
import { createSleepTool } from "./tools/sleep.js";
import { createListMachinesTool } from "./tools/list-machines.js";
import { createTaskOutputTool } from "./tools/task-output.js";
import { createCompareRunsTool } from "./tools/compare-runs.js";
import { createShowMetricsTool } from "./tools/show-metrics.js";
import { createClearMetricsTool } from "./tools/clear-metrics.js";
import { createKillTaskTool } from "./tools/kill-task.js";
import { createReadFileTool, createWriteFileTool, createPatchFileTool } from "./tools/file-ops.js";
import { createWebFetchTool } from "./tools/web-fetch.js";
import { createStartMonitorTool, createStopMonitorTool } from "./tools/monitor.js";
import { createConsultTool } from "./tools/consult.js";
import { createWriteupTool } from "./tools/writeup.js";
import { createHubTools } from "./tools/hub.js";
import { createMemoryTools } from "./tools/memory-tools.js";
import { createExperimentBranchTools } from "./tools/experiment-branch.js";
import { createEnvSnapshotTool } from "./tools/env-snapshot.js";
import { createSweepTool } from "./tools/sweep.js";
import { findProjectConfig } from "./config/project.js";
import { ResourceCollector } from "./metrics/resources.js";
import { Notifier } from "./notifications/index.js";
import { ExperimentBrancher } from "./experiments/branching.js";

const SYSTEM_PROMPT = `You are Helios, an autonomous ML research agent. You help researchers design, run, and monitor machine learning experiments on local and remote machines.

## Machines
- "local" is always available — it runs commands on the user's machine directly (no SSH).
- Remote machines are added by the user via /machine add. Use list_machines to see what's available.
- Prefer remote machines for heavy compute (training, GPU workloads). Use "local" for lightweight tasks or when no remote machines are configured.

## Capabilities
- Execute quick commands locally or remotely (remote_exec) — ONLY for short commands like ls, cat, pip install, git clone
- Launch and monitor training runs (remote_exec_background) — ALL training, evaluation, and long-running processes
- Track metrics like loss, accuracy, rewards (show_metrics)
- Transfer files between local and remote machines (remote_upload, remote_download)
- Read, write, and edit files on any machine (read_file, write_file, patch_file)
- Fetch web pages, documentation, and papers (web_fetch)
- Branch experiments in git (exp_branch, exp_commit, exp_diff, exp_branches, exp_checkout)
- Clear metrics from discarded runs (clear_metrics)
- Sleep and set triggers to wake on conditions (sleep)
- List configured machines (list_machines)
- Consult the other AI provider for a second opinion (consult)

## MANDATORY: Use remote_exec_background for ALL Runs
**EVERY training run, evaluation, benchmark, or process that takes more than a few seconds MUST use remote_exec_background.** Never use remote_exec for these — it blocks, produces no dashboard output, and breaks the entire monitoring pipeline.

remote_exec_background:
- Returns a pid and log_path
- Automatically appears in the TASKS panel
- Stdout/stderr is captured — Helios parses it for live metrics in the dashboard
- **DO NOT redirect stdout in your command** (no > file, no tee, no logging to file). Redirecting stdout breaks metric collection.
- To check output, use task_output — do NOT manually tail or cat the log file.

remote_exec is ONLY for quick one-shot commands (installing packages, checking files, git operations).

## Metric Tracking
When calling remote_exec_background, pass **metric_names** or **metric_patterns** to enable live dashboard charts:

- **metric_names**: List of names to parse in key=value or key: value format from stdout.
  Example: metric_names=["loss", "acc", "lr"] matches "loss=0.234 acc=0.95 lr=1e-4"
- **metric_patterns**: Map of name → regex with one capture group for the numeric value.
  Example: metric_patterns={"loss": "Loss:\\\\s*([\\\\d.e+-]+)"} matches "Loss: 0.234"

If neither is provided, no metrics will be tracked. ALWAYS specify metrics when launching a training run.

Training scripts MUST print metrics to stdout (one line per step/epoch). Do not redirect stdout.

Use **clear_metrics** to wipe stale data when discarding a failed run before starting a new one.

## Viewing Task Output
Use task_output to check on running tasks:
- task_output(machine_id, pid) — shows recent stdout/stderr
- task_output(machine_id, pid, lines=100) — show more lines
This is the preferred way to check task progress. Do not use remote_exec to manually tail logs.

## Monitoring Loop — PREFERRED APPROACH
After launching a background task, use **start_monitor** to set up periodic check-ins:
- start_monitor(goal="Train TinyStories to loss < 5.0", interval_minutes=2)
- The system will re-invoke you every N minutes with a status update containing:
  - Elapsed time, current interval, task statuses, latest metric values, your goal
- On each check-in, review progress, take actions if needed (check output, adjust, launch new runs)
- Call **stop_monitor** when the objective is complete

Set the interval to match what you're waiting for. Short runs: 1-2m. Medium runs: 5m. Long runs: 10-15m.
**IMPORTANT:** Calling start_monitor again replaces the current monitor — use this to adjust the interval as conditions change. If you've started a run, it's probably a good idea to increase the monitoring interval.

**CRITICAL: NEVER use \`sleep\` as a shell command (e.g., remote_exec with "sleep 60").** The shell sleep command wastes resources and blocks execution.

## Sleep & Wake (Advanced)
For one-off waits with specific trigger conditions, use the **sleep tool**:
- timer: wake after a duration
- process_exit: wake when a PID exits
- metric: wake on metric threshold
- file: wake on file change
- resource: wake on GPU/CPU threshold
Triggers can be composed with AND/OR logic. Prefer start_monitor for ongoing experiment loops.

## Showing Metrics to the User
Use show_metrics to render sparkline charts and values inline in the conversation:
- show_metrics(metric_names=["loss", "acc"]) — show specific metrics
- show_metrics(metric_names=["loss"], lines=100) — more data points
Use this when reporting results to the user so they can see the data.

## Comparing Experiments
Use compare_runs to compare two experiment runs side-by-side:
- compare_runs(task_a="local:1234", task_b="local:5678") — compare all shared metrics
Returns deltas and direction (improved/worsened/unchanged) for each metric. Use this to decide whether to keep or discard an experimental change.

## Experiment Branching
When working in a git repo, use experiment branches to track code changes per experiment:
1. **exp_branch(machine_id, repo_path, experiment_name)** — create a new branch before modifying code
2. Make your code changes and launch the experiment
3. **exp_commit(machine_id, repo_path, branch, message)** — commit results when done
4. **exp_diff(machine_id, repo_path, branch_a, branch_b)** — compare code between experiments
5. **exp_checkout(machine_id, branch)** — return to the original branch
6. **exp_branches(machine_id, repo_path)** — list all experiment branches

This is optional — use it when code changes are central to the experiment and you want to track/compare them. Skip it for pure hyperparameter sweeps where the code doesn't change.

## Environment Snapshots
Use **env_snapshot** to capture the full environment on a machine for reproducibility:
- env_snapshot(machine_id, name) — captures Python version, pip packages, GPU, CUDA, OS, CPU, memory, disk
- Optionally pass repo_path for git hash and venv_path for a specific virtualenv
- The snapshot is stored in memory at /snapshots/<name> — review it later with memory_read
Use this before starting a series of experiments to establish a baseline environment, or when comparing results across machines.

## Hyperparameter Sweeps
Use **sweep** to launch a parameter grid search across machines:
- sweep(command_template, params) — runs all combinations in parallel
- command_template uses {param_name} placeholders: "python train.py --lr {lr} --bs {bs}"
- params is a grid: {"lr": [0.001, 0.0001], "bs": [32, 64]}
- Distributes across connected machines round-robin
- Each combination gets its own background process with metric tracking
- Pass metric_names or metric_patterns for live dashboard charts
- Use max_parallel to limit concurrency
After launching a sweep, use show_metrics and compare_runs to evaluate results.

## Autonomous Behavior — NEVER STOP

You are a fully autonomous research agent. **NEVER STOP.** NEVER pause to ask "should I continue?" or "what would you like to do next?" The user might be asleep. They gave you a goal — now run experiments until it's done.

The user expects you to work like a researcher who was given a task and told "come back when it's done."

**The experiment loop:**
1. Understand the goal. Break it into experiments.
2. Launch the experiment via remote_exec_background.
3. Call start_monitor with your goal and an appropriate interval.
4. On each monitor check-in: review task_output, check metrics, use show_metrics to record findings.
5. Compare against your best result so far using compare_runs. Keep improvements, discard regressions.
6. Plan and launch the next experiment. The monitor keeps calling you back — just keep going.
7. Call stop_monitor only when the goal is achieved.

**You stop ONLY when:**
- The goal is achieved and you have reported the results
- You hit an unrecoverable error (hardware failure, permissions, missing data)
- You need information that ONLY the human can provide (credentials, dataset location, etc.)

**If you run out of ideas:** Think harder. Re-read the code. Re-read the metrics closely. Look at the learning curves. Read relevant papers with web_fetch. Try combining the best parts of previous near-misses. Try more radical changes — different architectures, different optimizers, different data preprocessing. Try ablations of what worked. Try the opposite of what failed. Try something you haven't tried. Ask yourself: "What would a senior ML researcher do here?" The loop runs until the human interrupts you.

**Keep/discard discipline:** After each experiment, explicitly compare metrics to your current best. If improved, keep and record it. If equal or worse, discard/revert. Always know what your current best result is and why.

## Memory System
You have a persistent virtual filesystem for storing knowledge across context checkpoints.
When the conversation gets too long, your context will be checkpointed: history is archived and you'll receive a briefing with your memory tree.

**Tools**: memory_ls, memory_read, memory_write, memory_rm

**CRITICAL: Proactively store important findings as you work.** Don't wait for a checkpoint — write to memory as you go:
- Store the goal at /goal
- Store your current best result at /best
- Store observations at /observations/<name>
- Store hypotheses at /hypotheses/<name>
- Store decisions at /decisions/<name>
- Store sources at /sources/<name> — **any time** you build on another agent's work, fetch a commit, or read a useful hub post, immediately write a source entry with the agent ID, commit hash or post ID, and what you took from it
- Experiments are auto-tracked at /experiments/ when you use remote_exec_background

After a checkpoint, you'll see a tree listing of all your stored knowledge. Use memory_read(path) to retrieve details, and memory_ls to explore.

**The gist is the key**: When listing nodes, you see path + gist. Make gists informative enough that you can decide whether to read the full content.

## Experiment Writeups
Use **writeup** to generate a structured experiment report. Pass your notes (goal, configs, metrics, observations) and it returns a formatted writeup. Useful for documenting results and for posting to AgentHub.

## Consulting the Other Provider
Use **consult** if you find yourself stuck. It sends a question to the other AI (Claude if you're OpenAI, OpenAI if you're Claude) and returns their response. Good for getting a second opinion on experiment design, debugging, or when you've exhausted your own ideas.

## Approach
- Think step-by-step about experiment design
- Monitor for common issues: loss divergence, NaN, OOM, dead GPUs
- Proactively suggest improvements based on observed metrics
- Be concise in responses but thorough in analysis
- Always check exit codes and stderr for errors when executing commands`;

const HUB_PROMPT_ADDENDUM = `

## AgentHub Collaboration
You are connected to AgentHub — a shared platform where multiple agents publish experiment code and results.

- **hub_leaves**: See the frontier of experiments (latest commits from all agents). Check this before starting work to avoid duplicating effort.
- **hub_log**: Browse recent commits, optionally filtered by agent.
- **hub_fetch**: Pull another agent's commit into your local repo to build on their work.
- **hub_push**: After a significant experiment, commit your code and push to AgentHub so others can build on it.
- **hub_diff**: Compare two commits to see what changed.
- **hub_post**: Share writeups, findings, or hypotheses on a channel.
- **hub_read**: Read what other agents have posted.
- **hub_reply**: Respond to another agent's post.

**Workflow**: Check leaves/posts before starting → run experiments → push results + post findings. Build on what works, note what doesn't.

**Source tracking**: Every time you fetch a commit or read a useful post, immediately write to /sources/<name> in memory with the agent ID, commit hash or post ID, and what you used from it. This ensures proper attribution survives context checkpoints. When writing experiment writeups, cite these sources.`;

export interface HeliosRuntime {
  orchestrator: Orchestrator;
  sleepManager: SleepManager;
  connectionPool: ConnectionPool;
  executor: RemoteExecutor;
  metricStore: MetricStore;
  metricCollector: MetricCollector;
  monitorManager: MonitorManager;
  experimentTracker: ExperimentTracker;
  memoryStore: MemoryStore;
  stickyManager: StickyManager;
  resourceCollector: ResourceCollector;
  notifier: Notifier | null;
  experimentBrancher: ExperimentBrancher;
  openaiOAuth: OpenAIOAuth;
  projectConfig: ReturnType<typeof findProjectConfig>;
  agentName?: string;
  cleanup: () => void;
}

export interface RuntimeOptions {
  provider?: "claude" | "openai";
  claudeMode?: "cli" | "api";
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<HeliosRuntime> {
  // Project config (helios.json in cwd or parent dirs)
  const projectConfig = findProjectConfig();

  const prefs = loadPreferences();
  const initialProvider = options.provider ?? projectConfig?.provider ?? prefs.lastProvider ?? "claude";
  const initialClaudeMode = options.claudeMode ?? prefs.claudeAuthMode;
  const agentId = process.env.AGENTHUB_AGENT ?? "";

  // Auth
  const authManager = new AuthManager();
  const openaiOAuth = new OpenAIOAuth(authManager);
  authManager.registerRefreshHandler("openai", (rt) => openaiOAuth.refresh(rt));

  // Shared session store (single instance for orchestrator + both providers)
  const sessionStore = new SessionStore(agentId);

  // Providers
  const claudeProvider = new ClaudeProvider(authManager, initialClaudeMode, sessionStore);
  const openaiProvider = new OpenAIProvider(authManager, sessionStore);

  // Remote
  const connPool = new ConnectionPool();
  const machines = loadMachines();
  for (const machine of machines) {
    connPool.addMachine(machine);
    connPool.connect(machine.id).catch((err) => {
      process.stderr.write(`[helios] Failed to connect to ${machine.id}: ${formatError(err)}\n`);
    });
  }

  const exec = new RemoteExecutor(connPool);
  const fileSync = new FileSync();
  for (const machine of machines) {
    fileSync.addMachine(machine);
  }

  // Metrics
  const metricStore = new MetricStore(agentId);
  const metricCollector = new MetricCollector(connPool, metricStore);

  // Memory
  const memoryStore = new MemoryStore("pending");
  const contextGate = new ContextGate(memoryStore);
  contextGate.setExecutor(exec);
  contextGate.setMetricStore(metricStore);
  const expTracker = new ExperimentTracker(memoryStore);

  // Resources, notifications, experiment branching
  const resourceCollector = new ResourceCollector(connPool);
  const notifier = projectConfig?.notifications
    ? new Notifier({
        channels: projectConfig.notifications.channels,
        events: projectConfig.notifications.events as any,
      })
    : null;
  const experimentBrancher = new ExperimentBrancher(exec);

  // Stickies
  const stickies = new StickyManager();

  // Hub config
  const hubConfig = loadHubConfig();

  // System prompt
  let systemPrompt = SYSTEM_PROMPT;
  if (hubConfig?.agentName) {
    systemPrompt = systemPrompt.replace(
      "You are Helios, an autonomous ML research agent.",
      `You are Helios agent "${hubConfig.agentName}". This is your unique identity — your agent ID is "${hubConfig.agentName}". When creating directories, naming files, identifying yourself in posts, or any time you need "your name" or "your agent ID", use "${hubConfig.agentName}". You are an autonomous ML research agent.`,
    );
  }
  if (hubConfig) {
    systemPrompt += HUB_PROMPT_ADDENDUM;
  }
  if (projectConfig?.instructions) {
    systemPrompt += `\n\n## Project Instructions\n${projectConfig.instructions}`;
  }

  // Orchestrator
  const orch = new Orchestrator({
    defaultProvider: initialProvider,
    systemPrompt,
    agentId,
    sessionStore,
  });
  orch.setContextGate(contextGate);
  orch.setStickyManager(stickies);
  orch.registerProvider(claudeProvider);
  orch.registerProvider(openaiProvider);

  // Tools
  orch.registerTools([
    createRemoteExecTool(exec),
    createRemoteExecBackgroundTool(exec, metricCollector),
    createUploadTool(fileSync),
    createDownloadTool(fileSync),
    createListMachinesTool(connPool),
    createTaskOutputTool(exec, connPool),
    createShowMetricsTool(metricStore),
    createCompareRunsTool(metricStore),
    createClearMetricsTool(metricStore, metricCollector),
    createKillTaskTool(exec, connPool, metricCollector),
    createReadFileTool(connPool),
    createWriteFileTool(connPool),
    createPatchFileTool(connPool),
    createWebFetchTool(),
    ...createMemoryTools(memoryStore),
    createConsultTool(
      () => orch.currentProvider?.name ?? null,
      (name) => orch.getProvider(name),
    ),
    createWriteupTool(() => orch.currentProvider ?? null),
    ...createExperimentBranchTools(experimentBrancher),
    createEnvSnapshotTool(exec, memoryStore),
    createSweepTool(exec, connPool, metricCollector),
  ]);

  if (hubConfig) {
    const hubClient = new HubClient(hubConfig);
    orch.registerTools(createHubTools(hubClient, exec));
  }

  // Scheduler
  const triggerScheduler = new TriggerScheduler(connPool);
  const sleepMgr = new SleepManager(triggerScheduler, orch);
  sleepMgr.setExecutor(exec);
  sleepMgr.setConnectionPool(connPool);
  sleepMgr.setMetricStore(metricStore);
  orch.registerTool(createSleepTool(sleepMgr));

  // Monitor
  const monitorMgr = new MonitorManager();
  orch.registerTools([
    createStartMonitorTool(monitorMgr),
    createStopMonitorTool(monitorMgr),
  ]);

  // Activate provider — await so it's ready before callers use the runtime
  try {
    await orch.switchProvider(initialProvider);
    const model = projectConfig?.model ?? prefs.model;
    if (model) await orch.setModel(model);
    if (prefs.reasoningEffort) await orch.setReasoningEffort(prefs.reasoningEffort as any);
  } catch (err) {
    process.stderr.write(`[helios] Failed to authenticate ${initialProvider} provider: ${formatError(err)}\n`);
  }

  return {
    orchestrator: orch,
    sleepManager: sleepMgr,
    connectionPool: connPool,
    executor: exec,
    metricStore,
    metricCollector,
    monitorManager: monitorMgr,
    experimentTracker: expTracker,
    memoryStore,
    stickyManager: stickies,
    resourceCollector,
    notifier,
    experimentBrancher,
    openaiOAuth,
    projectConfig,
    agentName: agentId || hubConfig?.agentName,
    cleanup: () => {
      monitorMgr.stop();
      triggerScheduler.stopAll();
      connPool.disconnectAll();
    },
  };
}
