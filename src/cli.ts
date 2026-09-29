#!/usr/bin/env bun

// Devin Agent CLI - Delegate tasks to Devin CLI agents with tmux integration
// Designed for orchestration with bidirectional communication

import { config, ReasoningEffort, SandboxMode } from "./config.ts";
import {
  startJob,
  loadJob,
  saveJob,
  listJobs,
  killJob,
  refreshJobStatus,
  cleanupOldJobs,
  deleteJob,
  sendToJob,
  getJobOutput,
  getJobFullOutput,
  getAttachCommand,
  getTurnSignal,
  getJobsJson,
  getStatusJson,
  buildCompactJobJson,
} from "./jobs.ts";
import type { CompactJobJson, Job } from "./jobs.ts";
import { isTmuxAvailable, listSessions } from "./tmux.ts";
import { cleanTerminalOutput } from "./output-cleaner.ts";
import { buildPromptContext, type BuiltPromptContext } from "./prompt-context.ts";

const HELP = `
Devin Agent - Delegate tasks to Devin CLI agents (tmux-based)

Usage:
  devin-agent start "prompt" [options]   Start agent in tmux session
  devin-agent status <jobId>             Check job status
  devin-agent await-turn <jobId>         Wait for agent to finish current turn
  devin-agent send <jobId> "message"     Send message to running agent
  devin-agent capture <jobId> [lines]    Capture recent output (default: 50 lines)
  devin-agent output <jobId>             Get full session output
  devin-agent attach <jobId>             Get tmux attach command
  devin-agent watch <jobId>              Stream output updates
  devin-agent jobs [--json]              List all jobs
  devin-agent sessions                   List active tmux sessions
  devin-agent kill <jobId>               Kill running job
  devin-agent clean                      Clean old completed jobs and orphaned tmux sessions
  devin-agent health                     Check tmux and devin availability

Options:
  -r, --reasoning <level>    Reasoning effort: low, medium, high, xhigh (default: medium)
  -m, --model <model>        Model family (default: swe-2)
  -s, --sandbox <mode>       Permissions: read-only, workspace-write, danger-full-access
                             (or native Devin modes: auto, accept-edits, smart, dangerous)
  --cloud                    Run agent as a Devin Cloud session (its own VM)
  --mode <mode>              Agent mode: normal, plan, ask (default: normal)
  -w, --wait                 Wait for completion before exiting
  --notify-on-complete <cmd>  Run command when job completes
  -d, --dir <path>           Working directory (default: cwd)
  --parent-session <id>      Parent session ID for linkage
  --map                      Include codebase map if available
  --dry-run                  Show prompt without executing
  --strip-ansi               Remove ANSI and Devin TUI noise from output (for capture/output)
  --clean                    Alias for --strip-ansi
  --json                     Output JSON (status, await-turn, jobs)
  --limit <n>                Limit jobs shown (jobs command only)
  --all                      Show all jobs (jobs command only)
  -h, --help                 Show this help

Examples:
  # Start an agent
  devin-agent start "Review src/ for security issues" --map -s read-only

  # Check on it
  devin-agent capture abc123

  # Send additional context
  devin-agent send abc123 "Also check the auth module"

  # Attach to watch interactively
  tmux attach -t devin-agent-abc123

  # Or use the attach command
  devin-agent attach abc123

Bidirectional Communication:
  - Use 'send' to give agents additional instructions mid-task
  - Use 'capture' to see recent output programmatically
  - Use 'attach' to interact directly in tmux
  - Press Ctrl+C in tmux to interrupt, type to continue conversation
`;

interface Options {
  reasoning: ReasoningEffort;
  model: string;
  sandbox: SandboxMode;
  waitForCompletion: boolean;
  cloud: boolean;
  agentMode: string;
  notifyOnComplete: string | null;
  dir: string;
  includeMap: boolean;
  parentSessionId: string | null;
  dryRun: boolean;
  stripAnsi: boolean;
  json: boolean;
  jobsLimit: number | null;
  jobsAll: boolean;
}

function parseArgs(args: string[]): {
  command: string;
  positional: string[];
  options: Options;
} {
  const options: Options = {
    reasoning: config.defaultReasoningEffort,
    model: config.model,
    sandbox: config.defaultSandbox,
    waitForCompletion: false,
    cloud: false,
    agentMode: config.defaultAgentMode,
    notifyOnComplete: null,
    dir: process.cwd(),
    includeMap: false,
    parentSessionId: null,
    dryRun: false,
    stripAnsi: false,
    json: false,
    jobsLimit: config.jobsListLimit,
    jobsAll: false,
  };

  const positional: string[] = [];
  let command = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (arg === "-r" || arg === "--reasoning") {
      const level = args[++i] as ReasoningEffort;
      if (config.reasoningEfforts.includes(level)) {
        options.reasoning = level;
      } else {
        console.error(`Invalid reasoning level: ${level}`);
        console.error(`Valid options: ${config.reasoningEfforts.join(", ")}`);
        process.exit(1);
      }
    } else if (arg === "-m" || arg === "--model") {
      options.model = args[++i];
    } else if (arg === "-s" || arg === "--sandbox") {
      const mode = args[++i] as SandboxMode;
      if (config.sandboxModes.includes(mode)) {
        options.sandbox = mode;
      } else {
        console.error(`Invalid sandbox mode: ${mode}`);
        console.error(`Valid options: ${config.sandboxModes.join(", ")}`);
        process.exit(1);
      }
    } else if (arg === "--cloud") {
      options.cloud = true;
    } else if (arg === "--mode") {
      const raw = args[++i];
      const mode = raw === "code" ? "normal" : raw;
      if ((config.agentModes as readonly string[]).includes(mode)) {
        options.agentMode = mode;
      } else {
        console.error(`Invalid agent mode: ${raw}`);
        console.error(`Valid options: ${config.agentModes.join(", ")}`);
        process.exit(1);
      }
    } else if (arg === "-w" || arg === "--wait") {
      options.waitForCompletion = true;
    } else if (arg === "--notify-on-complete") {
      options.notifyOnComplete = args[++i] ?? null;
      options.waitForCompletion = true;
    } else if (arg === "-d" || arg === "--dir") {
      options.dir = args[++i];
    } else if (arg === "--parent-session") {
      options.parentSessionId = args[++i] ?? null;
    } else if (arg === "--map") {
      options.includeMap = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--strip-ansi" || arg === "--clean") {
      options.stripAnsi = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--limit") {
      const raw = args[++i];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 1) {
        console.error(`Invalid limit: ${raw}`);
        process.exit(1);
      }
      options.jobsLimit = Math.floor(parsed);
    } else if (arg === "--all") {
      options.jobsAll = true;
    } else if (!arg.startsWith("-")) {
      if (!command) {
        command = arg;
      } else {
        positional.push(arg);
      }
    }
  }

  return { command, positional, options };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

function formatJobStatus(job: Job): string {
  const elapsed = job.startedAt
    ? formatDuration(
        (job.completedAt ? new Date(job.completedAt).getTime() : Date.now()) -
          new Date(job.startedAt).getTime()
      )
    : "-";

  const status = job.status.toUpperCase().padEnd(10);
  const promptPreview = job.prompt.slice(0, 50) + (job.prompt.length > 50 ? "..." : "");

  return `${job.id}  ${status}  ${elapsed.padEnd(8)}  ${job.reasoningEffort.padEnd(6)}  ${promptPreview}`;
}

function refreshJobsForDisplay(jobs: Job[]): Job[] {
  return jobs.map((job) => {
    if (job.status !== "running" && job.status !== "pending") return job;
    const refreshed = refreshJobStatus(job.id);
    return refreshed ?? job;
  });
}

function sortJobsRunningFirst(jobs: Job[]): Job[] {
  const statusRank: Record<Job["status"], number> = {
    running: 0,
    pending: 1,
    failed: 2,
    completed: 3,
  };

  return [...jobs].sort((a, b) => {
    const rankDiff = statusRank[a.status] - statusRank[b.status];
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function applyJobsLimit<T>(jobs: T[], limit: number | null): T[] {
  if (!limit || limit <= 0) return jobs;
  return jobs.slice(0, limit);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJobCompletion(
  jobId: string,
  pollIntervalMs = 1000
): Promise<Job | null> {
  while (true) {
    const refreshed = refreshJobStatus(jobId);
    if (!refreshed || refreshed.status !== "running") {
      return refreshed;
    }

    await sleep(pollIntervalMs);
  }
}

async function notifyOnCompletion(
  job: Job,
  notifyCommand: string | null
): Promise<void> {
  process.stdout.write("\x07");

  if (!notifyCommand) return;

  try {
    const { spawnSync } = await import("child_process");
    spawnSync(notifyCommand, {
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        DEVIN_AGENT_JOB_ID: job.id,
        DEVIN_AGENT_STATUS: job.status,
        DEVIN_AGENT_ERROR: job.error || "",
      },
    });
  } catch {
    // Best effort only; completion ping already emitted.
  }
}

function printDryRun(context: BuiltPromptContext, options: Options): void {
  const accounting = context.accounting;
  console.log(
    `Would send ~${accounting.estimatedTokens.toLocaleString()} tokens (${accounting.bytes.toLocaleString()} bytes)`
  );
  console.log(`Model: ${options.model}`);
  console.log(`Reasoning: ${options.reasoning}`);
  console.log(`Sandbox: ${options.sandbox}`);
  if (options.cloud) console.log("Cloud: yes");
  if (options.agentMode !== "normal") console.log(`Agent mode: ${options.agentMode}`);
  console.log("Prompt components:");
  for (const component of accounting.components) {
    console.log(
      `  - ${component.label}: ~${component.estimatedTokens.toLocaleString()} tokens, ${component.bytes.toLocaleString()} bytes`
    );
  }
  console.log(
    `Codebase map: ${accounting.map.included ? "included" : "not included"}`
  );
  if (accounting.map.included) {
    console.log(`Map path: ${accounting.map.path ?? "-"}`);
    console.log(
      `Map prompt cost: ~${accounting.map.estimatedTokens.toLocaleString()} tokens, ${accounting.map.bytes.toLocaleString()} bytes`
    );
    console.log(
      `Map metadata total_tokens: ${accounting.map.cartographerTotalTokens?.toLocaleString() ?? "-"}`
    );
  }
  console.log("\n--- Prompt Preview ---\n");
  console.log(context.prompt.slice(0, 3000));
  if (context.prompt.length > 3000) {
    console.log(`\n... (${context.prompt.length - 3000} more characters)`);
  }
}

async function buildCliPromptContext(taskPrompt: string, options: Options): Promise<BuiltPromptContext> {
  const context = await buildPromptContext({
    taskPrompt,
    includeMap: options.includeMap,
    cwd: options.dir,
  });

  if (options.includeMap) {
    console.error(context.accounting.map.included ? "Included codebase map" : "No codebase map found");
  }

  return context;
}

function formatNextAction(job: CompactJobJson): string {
  return job.actions.recommended_next;
}

function formatHumanStatus(job: CompactJobJson): string {
  const lines = [
    `State: ${job.orchestration_state}`,
    `Process: ${job.process_state}`,
    `Turn: ${job.turn_state}${job.blocker_kind ? ` (${job.blocker_kind})` : ""}`,
    `Turns completed: ${job.turns_completed}`,
    `Last message: ${job.last_message ?? "-"}`,
    `Next: ${formatNextAction(job)}`,
    `Job: ${job.id}`,
    `Status: ${job.status}`,
    `Model: ${job.model} (${job.reasoning})`,
    `Sandbox: ${job.sandbox}`,
    `Created: ${job.created_at}`,
  ];

  if (job.started_at) lines.push(`Started: ${job.started_at}`);
  if (job.completed_at) lines.push(`Completed: ${job.completed_at}`);
  if (job.last_activity_at) lines.push(`Last activity: ${job.last_activity_at}`);
  if (job.usage) {
    lines.push(
      `Usage: total=${job.usage.total.toLocaleString()} input=${job.usage.input.toLocaleString()} cached=${job.usage.cached_input.toLocaleString()} output=${job.usage.output.toLocaleString()}`
    );
  }
  if (job.context) {
    lines.push(
      `Context: ~${job.context.prompt_estimated_tokens.toLocaleString()} tokens, ${job.context.prompt_bytes.toLocaleString()} bytes`
    );
  }
  if (job.error) lines.push(`Error: ${job.error}`);

  return lines.join("\n");
}

type AwaitTurnResult = {
  shouldPoll: boolean;
  exitCode: number;
  message: string | null;
  reason: string | null;
  job: CompactJobJson;
};

function getAwaitTurnResult(job: Job): AwaitTurnResult {
  const compact = buildCompactJobJson(job);
  const fallbackMessage =
    compact.orchestration_state === "COMPLETED" ? "Job completed" : "Turn complete";

  switch (compact.orchestration_state) {
    case "WAITING":
      return {
        shouldPoll: false,
        exitCode: 0,
        message: compact.last_message ?? fallbackMessage,
        reason: null,
        job: compact,
      };
    case "COMPLETED":
      return {
        shouldPoll: false,
        exitCode: 0,
        message: compact.last_message ?? fallbackMessage,
        reason: null,
        job: compact,
      };
    case "BLOCKED":
      return {
        shouldPoll: false,
        exitCode: 2,
        message: null,
        reason: compact.blocker_kind
          ? `Job is blocked: ${compact.blocker_kind}`
          : "Job is blocked",
        job: compact,
      };
    case "FAILED":
      return {
        shouldPoll: false,
        exitCode: 1,
        message: null,
        reason: compact.error ?? "Job failed",
        job: compact,
      };
    case "CANCELLED":
      return {
        shouldPoll: false,
        exitCode: 1,
        message: null,
        reason: "Job was cancelled",
        job: compact,
      };
    case "STALE":
      return {
        shouldPoll: false,
        exitCode: 2,
        message: null,
        reason: "Job is stale",
        job: compact,
      };
    case "PENDING":
    case "STARTING":
    case "WORKING":
      return {
        shouldPoll: true,
        exitCode: 0,
        message: null,
        reason: null,
        job: compact,
      };
  }
}

function printAwaitTurnResult(result: AwaitTurnResult, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          schema_version: result.job.schema_version,
          generated_at: new Date().toISOString(),
          job: result.job,
          outcome: result.exitCode === 0 ? "ready" : "not_ready",
          message: result.message,
          reason: result.reason,
        },
        null,
        2
      )
    );
    return;
  }

  if (result.exitCode === 0) {
    console.log(result.message ?? "Turn complete");
  } else {
    console.error(result.reason ?? "Job cannot be awaited");
  }
}

function markSignalTurnComplete(job: Job, signalMessage: string | null, timestamp: string): Job {
  if (job.turnState !== "idle") {
    job.turnsCompleted = (job.turnsCompleted ?? job.turnCount ?? 0) + 1;
  }
  job.lastTurnCompletedAt = timestamp;
  job.lastAgentMessage = signalMessage;
  job.turnState = "idle";
  saveJob(job);
  return loadJob(job.id) ?? job;
}

async function awaitTurn(jobId: string, json: boolean): Promise<void> {
  const initial = refreshJobStatus(jobId);
  if (!initial) {
    console.error(`Job ${jobId} not found`);
    process.exit(1);
  }

  const existingSignal = getTurnSignal(jobId);
  if (existingSignal) {
    const completedTurn = markSignalTurnComplete(
      initial,
      existingSignal.lastAgentMessage,
      existingSignal.timestamp
    );
    const result = getAwaitTurnResult(completedTurn);
    printAwaitTurnResult(result, json);
    process.exit(result.exitCode);
  }

  const initialResult = getAwaitTurnResult(initial);
  if (!initialResult.shouldPoll) {
    printAwaitTurnResult(initialResult, json);
    process.exit(initialResult.exitCode);
  }

  if (!json) {
    console.error(`Waiting for turn completion... (job: ${jobId})`);
  }

  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
  });

  let awaitTurnPollCount = 0;
  const contextWindowText = "Devin ran out of room in the model's context window";

  while (!stopped) {
    await sleep(500);
    awaitTurnPollCount += 1;

    const signal = getTurnSignal(jobId);
    if (signal) {
      const current = refreshJobStatus(jobId) ?? loadJob(jobId);
      if (!current) {
        console.error(`Job ${jobId} not found`);
        process.exit(1);
      }
      const completedTurn = markSignalTurnComplete(current, signal.lastAgentMessage, signal.timestamp);
      const result = getAwaitTurnResult(completedTurn);
      printAwaitTurnResult(result, json);
      process.exit(result.exitCode);
    }

    if (awaitTurnPollCount % 5 === 0) {
      const paneOutput = getJobOutput(jobId, 10);
      if (paneOutput && (paneOutput.includes("ran out of room") || paneOutput.includes("context window"))) {
        const current = loadJob(jobId);
        if (current) {
          current.turnState = "context_limit";
          current.blockerKind = "context_limit";
          current.error = contextWindowText;
          saveJob(current);
          const result = getAwaitTurnResult(loadJob(jobId) ?? current);
          printAwaitTurnResult(result, json);
          process.exit(result.exitCode);
        }

        console.error("Agent hit context window limit");
        process.exit(2);
      }

      // Cloud sessions run on a remote VM: the local Stop hook and ATIF
      // export never fire, so fall back to the TUI idle marker (which can
      // sit well above the bottom padding).
      const cloudJob = loadJob(jobId);
      const cloudPane = cloudJob?.cloud ? getJobOutput(jobId, 60) : null;
      if (cloudJob?.cloud && cloudPane?.includes("awaiting instructions")) {
        const lastLine =
          cleanTerminalOutput(cloudPane)
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .pop() ?? null;
        const completedTurn = markSignalTurnComplete(
          cloudJob,
          lastLine,
          new Date().toISOString()
        );
        const result = getAwaitTurnResult(completedTurn);
        printAwaitTurnResult(result, json);
        process.exit(result.exitCode);
      }
    }

    const current = refreshJobStatus(jobId);
    if (!current) {
      console.error(`Job ${jobId} not found`);
      process.exit(1);
    }

    const result = getAwaitTurnResult(current);
    if (!result.shouldPoll) {
      printAwaitTurnResult(result, json);
      process.exit(result.exitCode);
    }
  }

  console.error("\nStopped waiting");
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const { command, positional, options } = parseArgs(args);

  try {
    switch (command) {
      case "health": {
        // Check tmux
        if (!isTmuxAvailable()) {
          console.error("tmux not found");
          console.error("Install with: brew install tmux");
          process.exit(1);
        }
        console.log("tmux: OK");

        // Check devin
        const { execSync } = await import("child_process");
        const { join } = await import("path");
        const localDevin = join(process.env.HOME ?? "", ".local", "bin", "devin");
        const envScrub = [
          "DEVIN_DIR",
          "DEVIN_REMOTE_STATE_DIR",
          "DEVIN_DISABLE_HISTEXPAND",
          "__COG_SHELL_INTEGRATION_SCRIPT",
          "__COG_BASH_ENV_SOURCED",
          "__COG_SKIP_PYENV",
          "ENVRC",
          "BASH_ENV",
        ]
          .map((name) => `-u ${name}`)
          .join(" ");
        const devinBin = (() => {
          for (const candidate of ["devin", localDevin]) {
            try {
              const version = execSync(`env ${envScrub} ${candidate} --version`, {
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
              }).trim();
              return { bin: candidate, version };
            } catch {
              // Try next candidate
            }
          }
          return null;
        })();
        if (!devinBin) {
          console.error("devin CLI not found");
          console.error("Install with: curl -fsSL https://cli.devin.ai/install.sh | sh");
          process.exit(1);
        }
        console.log(`devin: ${devinBin.version}`);

        try {
          const auth = execSync(`env ${envScrub} ${devinBin.bin} auth status`, {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }).trim();
          const loggedIn = auth.split("\n").find((line) => line.trim().startsWith("Logged in"));
          console.log(`auth: ${loggedIn ? loggedIn.trim() : "OK"}`);
        } catch {
          console.error("devin CLI not authenticated");
          console.error("Run: devin auth login");
          process.exit(1);
        }

        console.log("Status: Ready");
        break;
      }

      case "start": {
        if (positional.length === 0) {
          console.error("Error: No prompt provided");
          process.exit(1);
        }

        const taskPrompt = positional.join(" ");
        const promptContext = await buildCliPromptContext(taskPrompt, options);

        if (options.dryRun) {
          printDryRun(promptContext, options);
          process.exit(0);
        }

        // Check tmux first
        if (!isTmuxAvailable()) {
          console.error("Error: tmux is required but not installed");
          console.error("Install with: brew install tmux");
          process.exit(1);
        }

        const job = startJob({
          prompt: promptContext.prompt,
          promptContext: promptContext.accounting,
          model: options.model,
          reasoningEffort: options.reasoning,
          sandbox: options.sandbox,
          parentSessionId: options.parentSessionId ?? undefined,
          cwd: options.dir,
          cloud: options.cloud,
          agentMode: options.agentMode,
        });

        console.log(`Job started: ${job.id}${job.cloud ? " (cloud)" : ""}`);
        console.log(`Model: ${job.model} (${job.reasoningEffort})`);
        console.log(`Working dir: ${job.cwd}`);
        console.log(`tmux session: ${job.tmuxSession}`);
        console.log("");
        console.log("Commands:");
        console.log(`  Capture output:  devin-agent capture ${job.id}`);
        console.log(`  Send message:    devin-agent send ${job.id} "message"`);
        console.log(`  Attach session:  tmux attach -t ${job.tmuxSession}`);

        if (options.waitForCompletion) {
          const completed = await waitForJobCompletion(job.id);
          if (!completed) {
            console.error("Job disappeared while waiting");
            process.exit(1);
          }

          console.log(`\nJob ${completed.id} completed with status: ${completed.status}`);
          if (completed.status === "failed" && completed.error) {
            console.log(`Error: ${completed.error}`);
          }

          const finalOutput = getJobFullOutput(job.id);
          if (finalOutput) {
            console.log("");
            console.log(finalOutput);
          }

          await notifyOnCompletion(completed, options.notifyOnComplete);
        }
        break;
      }

      case "status": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        const job = refreshJobStatus(positional[0]);
        if (!job) {
          console.error(`Job ${positional[0]} not found`);
          process.exit(1);
        }

        const statusPayload = getStatusJson(positional[0]);
        if (!statusPayload) {
          console.error(`Job ${positional[0]} not found`);
          process.exit(1);
        }
        if (options.json) {
          console.log(JSON.stringify(statusPayload, null, 2));
          break;
        }

        console.log(formatHumanStatus(statusPayload.job));
        if (job.tmuxSession) {
          console.log(`tmux session: ${job.tmuxSession}`);
        }
        break;
      }

      case "await-turn": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        await awaitTurn(positional[0], options.json);
        break;
      }

      case "send": {
        if (positional.length < 2) {
          console.error("Error: Usage: devin-agent send <jobId> \"message\"");
          process.exit(1);
        }

        const jobId = positional[0];
        const message = positional.slice(1).join(" ");

        if (sendToJob(jobId, message)) {
          console.log(`Sent to ${jobId}: ${message}`);
        } else {
          console.error(`Could not send to job ${jobId}`);
          console.error("Job may not be running or tmux session not found");
          process.exit(1);
        }
        break;
      }

      case "capture": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        const lines = positional[1] ? parseInt(positional[1], 10) : 50;
        let output = getJobOutput(positional[0], lines);

        if (output) {
          if (options.stripAnsi) {
            output = cleanTerminalOutput(output);
          }
          console.log(output);
        } else {
          console.error(`Could not capture output for job ${positional[0]}`);
          process.exit(1);
        }
        break;
      }

      case "output": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        let output = getJobFullOutput(positional[0]);
        if (output) {
          if (options.stripAnsi) {
            output = cleanTerminalOutput(output);
          }
          console.log(output);
        } else {
          console.error(`Could not get output for job ${positional[0]}`);
          process.exit(1);
        }
        break;
      }

      case "attach": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        const attachCmd = getAttachCommand(positional[0]);
        if (attachCmd) {
          console.log(attachCmd);
        } else {
          console.error(`Job ${positional[0]} not found or no tmux session`);
          process.exit(1);
        }
        break;
      }

      case "watch": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        const job = loadJob(positional[0]);
        if (!job || !job.tmuxSession) {
          console.error(`Job ${positional[0]} not found or no tmux session`);
          process.exit(1);
        }

        console.error(`Watching ${job.tmuxSession}... (Ctrl+C to stop)`);
        console.error("For interactive mode, use: tmux attach -t " + job.tmuxSession);
        console.error("");

        // Simple polling-based watch
        let lastOutput = "";
        const pollInterval = setInterval(() => {
          const output = getJobOutput(positional[0], 100);
          if (output && output !== lastOutput) {
            // Print only new content
            if (lastOutput) {
              const newPart = output.replace(lastOutput, "");
              if (newPart.trim()) {
                process.stdout.write(newPart);
              }
            } else {
              console.log(output);
            }
            lastOutput = output;
          }

          // Check if job is still running
          const refreshed = refreshJobStatus(positional[0]);
          if (refreshed && refreshed.status !== "running") {
            console.error(`\nJob ${refreshed.status}`);
            clearInterval(pollInterval);
            process.exit(0);
          }
        }, 1000);

        // Handle Ctrl+C
        process.on("SIGINT", () => {
          clearInterval(pollInterval);
          console.error("\nStopped watching");
          process.exit(0);
        });
        break;
      }

      case "jobs": {
        if (options.json) {
          const limit = options.jobsAll ? null : options.jobsLimit;
          const payload = getJobsJson({
            all: options.jobsAll,
            limit,
          });
          console.log(JSON.stringify(payload, null, 2));
          break;
        }

        const limit = options.jobsAll ? null : options.jobsLimit;
        const allJobs = refreshJobsForDisplay(
          listJobs({
            all: options.jobsAll,
            limit,
          })
        );
        const sortedJobs = sortJobsRunningFirst(allJobs);
        const jobs = options.jobsAll ? sortedJobs : applyJobsLimit(sortedJobs, limit);
        if (jobs.length === 0) {
          console.log("No jobs");
        } else {
          console.log("ID        STATUS      ELAPSED   EFFORT  PROMPT");
          console.log("-".repeat(80));
          for (const job of jobs) {
            console.log(formatJobStatus(job));
          }
        }
        break;
      }

      case "sessions": {
        const sessions = listSessions();
        if (sessions.length === 0) {
          console.log("No active devin-agent sessions");
        } else {
          console.log("SESSION NAME                    ATTACHED  CREATED");
          console.log("-".repeat(60));
          for (const session of sessions) {
            const attached = session.attached ? "yes" : "no";
            console.log(
              `${session.name.padEnd(30)}  ${attached.padEnd(8)}  ${session.created}`
            );
          }
        }
        break;
      }

      case "kill": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        if (killJob(positional[0])) {
          console.log(`Killed job: ${positional[0]}`);
        } else {
          console.error(`Could not kill job: ${positional[0]}`);
          process.exit(1);
        }
        break;
      }

      case "clean": {
        const cleaned = cleanupOldJobs(7);
        console.log(
          `Cleaned ${cleaned.jobsDeleted} old jobs and killed ${cleaned.orphanedSessionsKilled} orphaned tmux sessions`
        );
        break;
      }

      case "delete": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        if (deleteJob(positional[0])) {
          console.log(`Deleted job: ${positional[0]}`);
        } else {
          console.error(`Could not delete job: ${positional[0]}`);
          process.exit(1);
        }
        break;
      }

      default:
        // Treat as prompt for start command
        if (command) {
          const taskPrompt = [command, ...positional].join(" ");
          const promptContext = await buildCliPromptContext(taskPrompt, options);

          if (options.dryRun) {
            printDryRun(promptContext, options);
            process.exit(0);
          }

          // Check tmux first
          if (!isTmuxAvailable()) {
            console.error("Error: tmux is required but not installed");
            console.error("Install with: brew install tmux");
            process.exit(1);
          }

          const job = startJob({
            prompt: promptContext.prompt,
            promptContext: promptContext.accounting,
            model: options.model,
            reasoningEffort: options.reasoning,
            sandbox: options.sandbox,
            parentSessionId: options.parentSessionId ?? undefined,
            cwd: options.dir,
            cloud: options.cloud,
            agentMode: options.agentMode,
          });

          console.log(`Job started: ${job.id}${job.cloud ? " (cloud)" : ""}`);
          console.log(`tmux session: ${job.tmuxSession}`);
          console.log(`Attach: tmux attach -t ${job.tmuxSession}`);

          if (options.waitForCompletion) {
            const completed = await waitForJobCompletion(job.id);
            if (!completed) {
              console.error("Job disappeared while waiting");
              process.exit(1);
            }
            console.log(`\nJob ${completed.id} completed with status: ${completed.status}`);
            if (completed.status === "failed" && completed.error) {
              console.log(`Error: ${completed.error}`);
            }
            const finalOutput = getJobFullOutput(job.id);
            if (finalOutput) {
              console.log("");
              console.log(finalOutput);
            }
            await notifyOnCompletion(completed, options.notifyOnComplete);
          }
        } else {
          console.log(HELP);
        }
    }
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }
}

main();
