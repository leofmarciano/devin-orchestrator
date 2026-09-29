// tmux helper functions for devin-agent

import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { config } from "./config.ts";

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
  created: string;
}

const SESSION_COMPLETE_MARKER = "[devin-agent: Session complete";
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

// Environment variables injected by a Devin remote session that make a child
// `devin` process think it is running inside Devin's own terminal tooling
// (editor bridge etc.). They are stripped when spawning job sessions so the
// orchestrated CLI behaves like it was launched from a normal terminal.
const DEVIN_SESSION_ENV_VARS = [
  "DEVIN_DIR",
  "DEVIN_REMOTE_STATE_DIR",
  "DEVIN_DISABLE_HISTEXPAND",
  "__COG_SHELL_INTEGRATION_SCRIPT",
  "__COG_BASH_ENV_SOURCED",
  "__COG_SKIP_PYENV",
  "ENVRC",
  "BASH_ENV",
  "EDITOR",
  "VISUAL",
  "GIT_EDITOR",
] as const;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Locate the devin binary: prefer PATH, fall back to the installer default
 * location (~/.local/bin/devin), which is frequently absent from the PATH that
 * tmux spawns shell commands under.
 */
export function resolveDevinBin(): string {
  try {
    execSync("which devin", { stdio: "pipe" });
    return "devin";
  } catch {
    return join(homedir(), ".local", "bin", "devin");
  }
}

function validateModelName(model: string): string {
  if (!MODEL_NAME_PATTERN.test(model)) {
    throw new Error("Invalid Devin model name");
  }

  return model;
}

// Model families that only offer {medium, high, max} effort variants.
const LIMITED_EFFORT_FAMILIES: Record<string, Record<string, string>> = {
  "swe-2": { low: "medium", medium: "medium", high: "high", xhigh: "max" },
  swe: { low: "medium", medium: "medium", high: "high", xhigh: "max" },
  "kimi-k3": { low: "low", medium: "high", high: "high", xhigh: "max" },
};

const EFFORT_SUFFIX_PATTERN = /-(none|low|medium|high|xhigh|max)$/i;

/**
 * Devin encodes reasoning effort in the model id (`<family>-<effort>`).
 * Compose the orchestrator's reasoning levels onto the configured model
 * family, clamping for families that only ship a subset of effort tiers.
 */
export function resolveDevinModel(model: string, reasoningEffort: string): string {
  const base = validateModelName(model).replace(EFFORT_SUFFIX_PATTERN, "");
  const table = LIMITED_EFFORT_FAMILIES[base.toLowerCase()];
  const suffix = table?.[reasoningEffort] ?? reasoningEffort;
  return `${base}-${suffix}`;
}

// Codex sandbox names map onto Devin permission modes:
//   read-only          -> auto          (auto-approves read-only tools)
//   workspace-write    -> accept-edits  (also auto-approves workspace edits)
//   danger-full-access -> dangerous     (auto-approves all tools)
// Native Devin mode names pass through untouched.
const SANDBOX_TO_PERMISSION_MODE: Record<string, string> = {
  "read-only": "auto",
  "workspace-write": "accept-edits",
  "danger-full-access": "dangerous",
  auto: "auto",
  "accept-edits": "accept-edits",
  smart: "smart",
  dangerous: "dangerous",
};

export function resolvePermissionMode(sandbox: string): string {
  return SANDBOX_TO_PERMISSION_MODE[sandbox] ?? "accept-edits";
}

// Minimal JSONC support for user config files, which allow // comments.
function parseJsonc(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // fall through to comment stripping
  }

  let stripped = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      stripped += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      stripped += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      stripped += "\n";
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      stripped += char;
    }
  }

  try {
    const parsed = JSON.parse(stripped);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getUserDevinConfigPath(): string {
  return join(homedir(), ".config", "devin", "config.json");
}

/**
 * Write a per-job Devin config that preserves the user's settings and adds the
 * Stop lifecycle hook used for turn-complete detection (Codex's `notify=[...]`
 * equivalent). Returns the path to pass to `devin --config`.
 */
export function writeJobDevinConfig(jobId: string, notifyHookPath: string): string | null {
  const notifyCommand = `bun run ${shellQuote(notifyHookPath)} ${jobId}`;

  let merged: Record<string, unknown> = {};
  const userConfigPath = getUserDevinConfigPath();
  try {
    if (existsSync(userConfigPath)) {
      merged = parseJsonc(readFileSync(userConfigPath, "utf-8")) ?? {};
    }
  } catch {
    merged = {};
  }

  const hooks = isPlainRecord(merged.hooks) ? { ...merged.hooks } : {};
  const existingStop = Array.isArray(hooks.Stop) ? [...hooks.Stop] : [];
  hooks.Stop = [
    ...existingStop,
    {
      matcher: "",
      hooks: [{ type: "command", command: notifyCommand }],
    },
  ];
  merged.hooks = hooks;

  // Skip background auto-update while a job session is running.
  merged.auto_update = false;

  try {
    mkdirSync(config.jobsDir, { recursive: true });
    const configPath = `${config.jobsDir}/${jobId}.devin-config.json`;
    writeFileSync(configPath, JSON.stringify(merged, null, 2));
    return configPath;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildDevinArgs(options: {
  model: string;
  reasoningEffort: string;
  sandbox: string;
  configFile: string;
  exportFile: string;
}): string {
  const model = resolveDevinModel(options.model, options.reasoningEffort);
  const permissionMode = resolvePermissionMode(options.sandbox);

  return [
    `--model`,
    shellQuote(model),
    `--permission-mode`,
    shellQuote(permissionMode),
    `--respect-workspace-trust`,
    `false`,
    `--config`,
    shellQuote(options.configFile),
    `--export`,
    shellQuote(options.exportFile),
  ].join(" ");
}

function listManagedSessionNames(): string[] {
  const prefixPattern = `${config.tmuxPrefix}-*`;

  try {
    const output = execSync(
      `tmux list-sessions -F "#{session_name}" -f "#{m:${prefixPattern},#{session_name}}" 2>/dev/null`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    try {
      const output = execSync(
        `tmux list-sessions -F "#{session_name}" 2>/dev/null`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );

      return output
        .trim()
        .split("\n")
        .filter((line) => line.startsWith(`${config.tmuxPrefix}-`));
    } catch {
      return [];
    }
  }
}

/**
 * Get tmux session name for a job
 */
export function getSessionName(jobId: string): string {
  return `${config.tmuxPrefix}-${jobId}`;
}

/**
 * Check if tmux is available
 */
export function isTmuxAvailable(): boolean {
  try {
    execSync("which tmux", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a tmux session exists
 */
export function sessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new tmux session running devin (interactive mode)
 */
export function createSession(options: {
  jobId: string;
  prompt: string;
  model: string;
  reasoningEffort: string;
  sandbox: string;
  cwd: string;
}): { sessionName: string; success: boolean; error?: string } {
  const sessionName = getSessionName(options.jobId);
  const logFile = `${config.jobsDir}/${options.jobId}.log`;
  const jobFile = `${config.jobsDir}/${options.jobId}.json`;
  const atifFile = `${config.jobsDir}/${options.jobId}.atif.json`;
  const notifyHook = `${import.meta.dir}/notify-hook.ts`;

  // Write prompt to a file so the shell command can read it without escaping issues
  const promptFile = `${config.jobsDir}/${options.jobId}.prompt`;
  const fs = require("fs");
  fs.writeFileSync(promptFile, options.prompt);

  try {
    // Per-job Devin config carrying the Stop hook (turn-complete signal) merged
    // on top of the user's existing config.
    const configFile = writeJobDevinConfig(options.jobId, notifyHook);
    if (!configFile) {
      throw new Error("Failed to write Devin job config");
    }

    const devinArgs = buildDevinArgs({
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      sandbox: options.sandbox,
      configFile,
      exportFile: atifFile,
    });

    const indexFile = `${config.jobsDir}/index.json`;
    const completionScript = [
      `import { readFileSync, writeFileSync, renameSync } from "fs";`,
      `const jobPath = process.argv[1];`,
      `const exitCode = Number(process.argv[2] ?? "0");`,
      `const indexPath = process.argv[3];`,
      `const atifPath = process.argv[4];`,
      `function parseUsage(text) {`,
      `  try {`,
      `    const parsed = JSON.parse(text);`,
      `    const m = parsed && parsed.final_metrics;`,
      `    if (!m) return null;`,
      `    const input = m.total_prompt_tokens;`,
      `    const output = m.total_completion_tokens;`,
      `    if (typeof input !== "number" || typeof output !== "number") return null;`,
      `    return { total: input + output, input, cached_input: m.total_cached_tokens || 0, output, steps: m.total_steps };`,
      `  } catch { return null; }`,
      `}`,
      `try {`,
      `  const job = JSON.parse(readFileSync(jobPath, "utf-8"));`,
      `  if (job.status === "running" || job.status === "pending") {`,
      `    job.status = exitCode === 0 ? "completed" : "failed";`,
      `    job.completedAt = new Date().toISOString();`,
      `    job.turnState = "idle";`,
      `    if (exitCode !== 0 && !job.error) {`,
      `      job.error = \`Devin exited with code \${exitCode}\`;`,
      `    }`,
      `    try {`,
      `      const usage = parseUsage(readFileSync(atifPath, "utf-8"));`,
      `      if (usage) job.usage = usage;`,
      `    } catch {}`,
      `    writeFileSync(jobPath, JSON.stringify(job, null, 2));`,
      `  }`,
      `  try {`,
      `    const idx = JSON.parse(readFileSync(indexPath, "utf-8"));`,
      `    if (idx.jobs && idx.jobs[job.id]) {`,
      `      delete idx.jobs[job.id];`,
      `      idx.updatedAt = new Date().toISOString();`,
      `      const tmp = indexPath + "." + process.pid + ".tmp";`,
      `      writeFileSync(tmp, JSON.stringify(idx, null, 2));`,
      `      renameSync(tmp, indexPath);`,
      `    }`,
      `  } catch {}`,
      `} catch {`,
      `  process.exit(0);`,
      `}`,
    ].join(" ");

    const completionHook = [
      `exit_code=$?`,
      `bun -e ${shellQuote(completionScript)} ${shellQuote(jobFile)} "$exit_code" ${shellQuote(indexFile)} ${shellQuote(atifFile)}`,
      `echo "\\n\\n[devin-agent: Session complete. Closing in 5s.]"`,
      `sleep 5`,
      `tmux kill-session -t ${shellQuote(sessionName)}`,
    ].join("; ");

    // Pass prompt via $(cat promptFile) so devin receives it at launch.
    // This avoids all fragile tmux send-keys timing issues with the TUI.
    // Platform-aware script command:
    //   macOS: script -q <file> <command>
    //   Linux: script -q -e -c "<command>" <file>
    const envScrub = DEVIN_SESSION_ENV_VARS.map((name) => `-u ${name}`).join(" ");
    const isLinux = process.platform === "linux";
    const devinBin = resolveDevinBin();
    const devinCmd = `env ${envScrub} ${shellQuote(devinBin)} ${devinArgs} -- "$(cat ${shellQuote(promptFile)})"`;
    const shellCmd = isLinux
      ? `script -q -e -c ${shellQuote(devinCmd)} ${shellQuote(logFile)}; ${completionHook}`
      : `script -q ${shellQuote(logFile)} ${devinCmd}; ${completionHook}`;

    const tmuxResult = spawnSync(
      "tmux",
      ["new-session", "-d", "-s", sessionName, "-c", options.cwd, shellCmd],
      { stdio: "pipe", cwd: options.cwd }
    );
    if (tmuxResult.status !== 0) {
      throw new Error((tmuxResult.stderr || tmuxResult.stdout).toString() || "tmux new-session failed");
    }

    return { sessionName, success: true };
  } catch (err) {
    return {
      sessionName,
      success: false,
      error: (err as Error).message,
    };
  }
}

/**
 * Send a message to a running devin session
 */
export function sendMessage(sessionName: string, message: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    const escapedMessage = message.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t "${sessionName}" '${escapedMessage}'`, {
      stdio: "pipe",
    });
    // Small delay before Enter for TUI to process
    spawnSync("sleep", ["0.3"]);
    execSync(`tmux send-keys -t "${sessionName}" Enter`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a control key to a session (like Ctrl+C)
 */
export function sendControl(sessionName: string, key: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    execSync(`tmux send-keys -t "${sessionName}" ${key}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture the current pane content
 */
export function capturePane(
  sessionName: string,
  options: { lines?: number; start?: number } = {}
): string | null {
  if (!sessionExists(sessionName)) {
    return null;
  }

  try {
    let cmd = `tmux capture-pane -t "${sessionName}" -p`;

    if (options.start !== undefined) {
      cmd += ` -S ${options.start}`;
    }

    const output = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });

    if (options.lines) {
      const allLines = output.split("\n");
      return allLines.slice(-options.lines).join("\n");
    }

    return output;
  } catch {
    return null;
  }
}

/**
 * Get the full scrollback buffer
 */
export function captureFullHistory(sessionName: string): string | null {
  if (!sessionExists(sessionName)) {
    return null;
  }

  try {
    // Capture from start of history (-S -) to end
    const output = execSync(
      `tmux capture-pane -t "${sessionName}" -p -S -`,
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }
    );
    return output;
  } catch {
    return null;
  }
}

/**
 * Kill a tmux session
 */
export function killSession(sessionName: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    execSync(`tmux kill-session -t "${sessionName}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * List all devin-agent sessions
 */
export function listSessions(): TmuxSession[] {
  try {
    const output = execSync(
      `tmux list-sessions -F "#{session_name}|#{session_attached}|#{session_windows}|#{session_created}" 2>/dev/null`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );

    return output
      .trim()
      .split("\n")
      .filter((line) => line.startsWith(config.tmuxPrefix))
      .map((line) => {
        const [name, attached, windows, created] = line.split("|");
        return {
          name,
          attached: attached === "1",
          windows: parseInt(windows, 10),
          created: new Date(parseInt(created, 10) * 1000).toISOString(),
        };
      });
  } catch {
    return [];
  }
}

/**
 * Kill devin-agent sessions already sitting on the completion banner
 */
export function cleanupCompletedSessions(): string[] {
  const killed: string[] = [];

  for (const sessionName of listManagedSessionNames()) {
    const output = capturePane(sessionName, { lines: 20 });
    if (!output || !output.includes(SESSION_COMPLETE_MARKER)) {
      continue;
    }

    if (killSession(sessionName)) {
      killed.push(sessionName);
    }
  }

  return killed;
}

/**
 * Kill devin-agent tmux sessions that do not belong to active jobs.
 * Sessions younger than 30s are skipped to avoid racing with startJob().
 */
export function cleanupOrphanedSessions(activeSessionNames: Iterable<string>): string[] {
  const active = new Set(activeSessionNames);
  const killed: string[] = [];
  const now = Date.now();

  for (const sessionName of listManagedSessionNames()) {
    if (active.has(sessionName)) {
      continue;
    }

    // Skip young sessions - they may still be in the startup window
    // where the job JSON hasn't recorded tmuxSession yet.
    try {
      const created = execSync(
        `tmux display-message -t "${sessionName}" -p "#{session_created}"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      const ageMs = now - parseInt(created, 10) * 1000;
      if (ageMs < 30_000) continue;
    } catch {
      // If we can't read session age, skip it to be safe
      continue;
    }

    if (killSession(sessionName)) {
      killed.push(sessionName);
    }
  }

  return killed;
}

/**
 * Get the command to attach to a session (for display to user)
 */
export function getAttachCommand(sessionName: string): string {
  return `tmux attach -t "${sessionName}"`;
}

/**
 * Check if the session's devin process is still running
 */
export function isSessionActive(sessionName: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    // Check if the pane has a running process
    const pid = execSync(
      `tmux list-panes -t "${sessionName}" -F "#{pane_pid}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    if (!pid) return false;

    // Check if that process is still running
    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Watch a session's output (returns a stream of updates)
 * This is for programmatic watching - for interactive use, just attach
 */
export function watchSession(
  sessionName: string,
  callback: (content: string) => void,
  intervalMs: number = 1000
): { stop: () => void } {
  let lastContent = "";
  let running = true;

  const interval = setInterval(() => {
    if (!running) return;

    const content = capturePane(sessionName, { lines: 100 });
    if (content && content !== lastContent) {
      // Only send the new lines
      const newContent = content.replace(lastContent, "").trim();
      if (newContent) {
        callback(newContent);
      }
      lastContent = content;
    }

    // Check if session still exists
    if (!sessionExists(sessionName)) {
      running = false;
      clearInterval(interval);
    }
  }, intervalMs);

  return {
    stop: () => {
      running = false;
      clearInterval(interval);
    },
  };
}
