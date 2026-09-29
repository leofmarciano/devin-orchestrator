// Job management for async devin agent execution with tmux

import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, renameSync } from "fs";
import { join, resolve, sep } from "path";
import { config, ReasoningEffort, SandboxMode } from "./config.ts";
import { randomBytes } from "crypto";
import { parseAtifFile, type ParsedSessionData } from "./atif-parser.ts";
import {
  createSession,
  cleanupCompletedSessions,
  cleanupOrphanedSessions,
  killSession,
  sessionExists,
  capturePane,
  captureFullHistory,
  isSessionActive,
  sendMessage,
  sendControl,
} from "./tmux.ts";
import { clearSignalFile, signalFileExists, readSignalFile, type TurnEvent } from "./watcher.ts";
import { deriveJobView, JOB_STATE_SCHEMA_VERSION, normalizeJobLifecycle } from "./state.ts";
import type {
  BlockerKind,
  LegacyTurnState,
  OrchestrationState,
  ProcessState,
  TurnState,
} from "./state.ts";
import type { PromptContextAccounting } from "./prompt-context.ts";
import { parseAtifUsage, parseContextWindow, type DevinTokenUsage } from "./metrics-parser.ts";

export interface Job {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  processState?: ProcessState;
  prompt: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
  parentSessionId?: string;
  devinSessionId?: string;
  cloud?: boolean;
  agentMode?: string;
  cwd: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  tmuxSession?: string;
  result?: string;
  error?: string;
  // Turn tracking
  turnsCompleted?: number;
  turnCount?: number;
  lastTurnCompletedAt?: string;
  lastAgentMessage?: string;
  turnState?: LegacyTurnState;
  blockerKind?: BlockerKind | null;
  promptEstimatedTokens?: number;
  promptBytes?: number;
  promptContext?: PromptContextAccounting;
  usage?: DevinTokenUsage;
}

interface JobIndexEntry {
  status: "pending" | "running";
}

interface JobIndex {
  updatedAt: string;
  jobs: Record<string, JobIndexEntry>;
}

export interface ListJobsOptions {
  all?: boolean;
  limit?: number | null;
}

function ensureJobsDir(): void {
  mkdirSync(config.jobsDir, { recursive: true });
}

function generateJobId(): string {
  return randomBytes(4).toString("hex");
}

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isValidJobId(jobId: string): boolean {
  return JOB_ID_PATTERN.test(jobId);
}

function isUnderJobsDir(filePath: string): boolean {
  const jobsDir = resolve(config.jobsDir);
  const resolved = resolve(filePath);
  return resolved === jobsDir || resolved.startsWith(`${jobsDir}${sep}`);
}

function getJobArtifactPath(jobId: string, extension: string): string | null {
  if (!isValidJobId(jobId)) return null;

  const artifactPath = resolve(config.jobsDir, `${jobId}${extension}`);
  return isUnderJobsDir(artifactPath) ? artifactPath : null;
}

function getJobPath(jobId: string): string | null {
  return getJobArtifactPath(jobId, ".json");
}

function getJobTrashDir(jobId: string): string | null {
  if (!isValidJobId(jobId)) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trashDir = resolve(config.jobsDir, ".trash", `${stamp}-${process.pid}-${jobId}`);
  return isUnderJobsDir(trashDir) ? trashDir : null;
}

export function archiveJobArtifacts(jobId: string): string[] {
  ensureJobsDir();
  const trashDir = getJobTrashDir(jobId);
  if (!trashDir) return [];

  const artifactExtensions = [".json", ".prompt", ".log", ".turn-complete", ".atif.json", ".devin-config.json"];
  const archived: string[] = [];

  for (const ext of artifactExtensions) {
    const source = getJobArtifactPath(jobId, ext);
    if (!source) continue;

    try {
      statSync(source);
    } catch {
      continue;
    }

    mkdirSync(trashDir, { recursive: true });
    const target = join(trashDir, `${jobId}${ext}`);
    try {
      renameSync(source, target);
      archived.push(target);
    } catch {
      // Best-effort archive: leave any artifact in place if it cannot be moved.
    }
  }

  return archived;
}

function createEmptyJobIndex(): JobIndex {
  return {
    updatedAt: new Date().toISOString(),
    jobs: {},
  };
}

function isActiveJobStatus(status: Job["status"]): status is "pending" | "running" {
  return status === "pending" || status === "running";
}

function isJobJsonFile(fileName: string): boolean {
  return (
    fileName.endsWith(".json") &&
    fileName !== "index.json" &&
    !fileName.endsWith(".atif.json") &&
    !fileName.endsWith(".devin-config.json")
  );
}

function loadJobFromPath(jobPath: string): Job | null {
  try {
    const content = readFileSync(jobPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function listAllJobsFromDirectory(): Job[] {
  const files = readdirSync(config.jobsDir).filter(isJobJsonFile);
  return files
    .map((fileName) => loadJobFromPath(join(config.jobsDir, fileName)))
    .filter((job): job is Job => job !== null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function readJobIndex(): JobIndex | null {
  try {
    const content = readFileSync(config.jobsIndexFile, "utf-8");
    const parsed = JSON.parse(content) as Partial<JobIndex>;
    const jobs = parsed.jobs && typeof parsed.jobs === "object" ? parsed.jobs : {};

    return {
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      jobs: Object.fromEntries(
        Object.entries(jobs).filter(
          ([jobId, entry]) =>
            typeof jobId === "string" &&
            !!entry &&
            typeof entry === "object" &&
            (((entry as JobIndexEntry).status === "pending") ||
              (entry as JobIndexEntry).status === "running")
        )
      ) as JobIndex["jobs"],
    };
  } catch {
    return null;
  }
}

function writeJobIndex(index: JobIndex): void {
  ensureJobsDir();
  index.updatedAt = new Date().toISOString();
  // Atomic write: temp file + rename to avoid partial reads from concurrent processes
  const tmpFile = `${config.jobsIndexFile}.${process.pid}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(index, null, 2));
  renameSync(tmpFile, config.jobsIndexFile);
}

function rebuildJobIndex(): JobIndex {
  const index = createEmptyJobIndex();

  for (const job of listAllJobsFromDirectory()) {
    if (isActiveJobStatus(job.status)) {
      index.jobs[job.id] = { status: job.status };
    }
  }

  writeJobIndex(index);
  return index;
}

function getOrRebuildJobIndex(): JobIndex {
  const index = readJobIndex();
  if (index) return index;
  return rebuildJobIndex();
}

function syncJobIndex(job: Job): void {
  const index = readJobIndex() ?? createEmptyJobIndex();

  if (isActiveJobStatus(job.status)) {
    index.jobs[job.id] = { status: job.status };
  } else {
    delete index.jobs[job.id];
  }

  writeJobIndex(index);
}

function removeJobFromIndex(jobId: string): void {
  const index = readJobIndex();
  if (!index || !index.jobs[jobId]) return;

  delete index.jobs[jobId];
  writeJobIndex(index);
}

function loadIndexedActiveJobs(index: JobIndex): Job[] {
  const jobs: Job[] = [];
  let isDirty = false;

  for (const jobId of Object.keys(index.jobs)) {
    const job = loadJob(jobId);
    if (!job || !isActiveJobStatus(job.status)) {
      delete index.jobs[jobId];
      isDirty = true;
      continue;
    }

    jobs.push(job);
  }

  if (isDirty) {
    writeJobIndex(index);
  }

  return jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function listRecentJobFilesByMtime(activeJobIds: Set<string>, limit: number): string[] {
  if (limit <= 0) return [];

  return readdirSync(config.jobsDir)
    .filter(isJobJsonFile)
    .filter((fileName) => !activeJobIds.has(fileName.slice(0, -".json".length)))
    .map((fileName) => {
      try {
        return {
          fileName,
          mtimeMs: statSync(join(config.jobsDir, fileName)).mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { fileName: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.fileName);
}

export function saveJob(job: Job): void {
  ensureJobsDir();
  const normalized = normalizeJobLifecycle(job);
  const jobPath = getJobPath(job.id);
  if (!jobPath) {
    throw new Error(`Invalid job id: ${job.id}`);
  }

  writeFileSync(jobPath, JSON.stringify(normalized, null, 2));
  syncJobIndex(normalized);
}

export function loadJob(jobId: string): Job | null {
  const jobPath = getJobPath(jobId);
  return jobPath ? loadJobFromPath(jobPath) : null;
}

export function listJobs(options: ListJobsOptions = {}): Job[] {
  ensureJobsDir();
  if (options.all) {
    return listAllJobsFromDirectory();
  }

  const limit = options.limit ?? config.jobsListLimit;
  const index = getOrRebuildJobIndex();
  const activeJobs = loadIndexedActiveJobs(index);
  const activeJobIds = new Set(activeJobs.map((job) => job.id));
  const recentLimit = Math.max(limit - activeJobs.length, 0);
  const recentJobs = listRecentJobFilesByMtime(activeJobIds, recentLimit)
    .map((fileName) => loadJobFromPath(join(config.jobsDir, fileName)))
    .filter((job): job is Job => job !== null);

  return [...activeJobs, ...recentJobs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

function computeElapsedMs(job: Job): number {
  const start = job.startedAt ?? job.createdAt;
  const startMs = Date.parse(start);
  const endMs = job.completedAt ? Date.parse(job.completedAt) : Date.now();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, endMs - startMs);
}

function getLogMtimeMs(jobId: string): number | null {
  const logFile = getJobArtifactPath(jobId, ".log");
  if (!logFile) return null;

  try {
    return statSync(logFile).mtimeMs;
  } catch {
    return null;
  }
}

function getLastActivityMs(job: Job): number | null {
  const logMtime = getLogMtimeMs(job.id);
  if (logMtime !== null) return logMtime;

  const fallback = job.startedAt ?? job.createdAt;
  const fallbackMs = Date.parse(fallback);
  if (!Number.isFinite(fallbackMs)) return null;
  return fallbackMs;
}

function isInactiveTimedOut(job: Job): boolean {
  const timeoutMinutes = config.defaultTimeout;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return false;

  const lastActivityMs = getLastActivityMs(job);
  if (!lastActivityMs) return false;

  return Date.now() - lastActivityMs > timeoutMinutes * 60 * 1000;
}

function getAtifPath(jobId: string): string | null {
  return getJobArtifactPath(jobId, ".atif.json");
}

function loadSessionData(jobId: string): ParsedSessionData | null {
  const atifPath = getAtifPath(jobId);
  if (!atifPath) return null;

  const data = parseAtifFile(atifPath);
  if (!data) return null;

  // The ATIF export carries cumulative tokens but no context window; the TUI
  // status bar renders it as `Context: <used> / <window> tokens (<pct>%)`.
  if (data.tokens) {
    const logFile = getJobArtifactPath(jobId, ".log");
    if (logFile) {
      try {
        const context = parseContextWindow(readFileSync(logFile, "utf-8"));
        if (context) {
          data.tokens.context_window = context.context_window;
          data.tokens.context_used_pct = context.context_used_pct;
        }
      } catch {
        // Log file may be missing
      }
    }
  }

  return data;
}

function loadDevinUsage(jobId: string): DevinTokenUsage | null {
  const atifPath = getAtifPath(jobId);
  if (!atifPath) return null;

  try {
    return parseAtifUsage(readFileSync(atifPath, "utf-8"));
  } catch {
    return null;
  }
}

function isSameUsage(a: DevinTokenUsage | undefined, b: DevinTokenUsage): boolean {
  return (
    a?.total === b.total &&
    a.input === b.input &&
    a.cached_input === b.cached_input &&
    a.output === b.output
  );
}

function persistDevinUsage(job: Job): Job {
  const usage = loadDevinUsage(job.id);
  if (!usage || isSameUsage(job.usage, usage)) return job;

  const updated = { ...job, usage };
  saveJob(updated);
  return updated;
}

function getLastActivityAt(job: Job, derivedLastActivityAt: string | null): string | null {
  const logMtime = getLogMtimeMs(job.id);
  if (logMtime !== null) return new Date(logMtime).toISOString();
  return derivedLastActivityAt;
}

function getStaleAfterMs(): number | null {
  if (!Number.isFinite(config.defaultTimeout) || config.defaultTimeout <= 0) return null;
  return config.defaultTimeout * 60 * 1000;
}

type CompactJobContext = {
  prompt_estimated_tokens: number;
  prompt_bytes: number;
  map: {
    included: boolean;
    path: string | null;
    estimated_tokens: number;
    bytes: number;
    cartographer_total_tokens: number | null;
  };
  components: {
    kind: string;
    label: string;
    estimated_tokens: number;
    bytes: number;
  }[];
};

function buildCompactContext(job: Job): CompactJobContext | null {
  const accounting = job.promptContext;
  if (!accounting) {
    if (job.promptEstimatedTokens === undefined && job.promptBytes === undefined) return null;
    return {
      prompt_estimated_tokens: job.promptEstimatedTokens ?? 0,
      prompt_bytes: job.promptBytes ?? 0,
      map: {
        included: false,
        path: null,
        estimated_tokens: 0,
        bytes: 0,
        cartographer_total_tokens: null,
      },
      components: [],
    };
  }

  return {
    prompt_estimated_tokens: accounting.estimatedTokens,
    prompt_bytes: accounting.bytes,
    map: {
      included: accounting.map.included,
      path: accounting.map.path,
      estimated_tokens: accounting.map.estimatedTokens,
      bytes: accounting.map.bytes,
      cartographer_total_tokens: accounting.map.cartographerTotalTokens,
    },
    components: accounting.components.map((component) => ({
      kind: component.kind,
      label: component.label,
      estimated_tokens: component.estimatedTokens,
      bytes: component.bytes,
    })),
  };
}

function getRecommendedNext(state: OrchestrationState): string {
  switch (state) {
    case "PENDING":
    case "STARTING":
    case "WORKING":
      return "await_turn";
    case "WAITING":
      return "send_or_close";
    case "BLOCKED":
      return "resolve_blocker";
    case "STALE":
      return "inspect_or_cancel";
    case "COMPLETED":
      return "close";
    case "FAILED":
      return "inspect_failure";
    case "CANCELLED":
      return "none";
  }
}

function getLastMessage(job: Job, sessionData: ParsedSessionData | null): string | null {
  if (job.lastAgentMessage) return job.lastAgentMessage;
  if (sessionData?.summary) return truncateText(sessionData.summary, 500);
  return null;
}

export type CompactJobJson = {
  schema_version: typeof JOB_STATE_SCHEMA_VERSION;
  id: string;
  orchestration_state: OrchestrationState;
  status: Job["status"];
  process_state: ProcessState;
  turn_state: TurnState;
  blocker_kind: BlockerKind | null;
  turns_completed: number;
  last_message: string | null;
  last_activity_at: string | null;
  usage: DevinTokenUsage | null;
  context: CompactJobContext | null;
  actions: {
    recommended_next: string;
  };
  model: string;
  reasoning: ReasoningEffort;
  sandbox: SandboxMode;
  cwd: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
};

export function buildCompactJobJson(job: Job): CompactJobJson {
  const derived = deriveJobView(job, { staleAfterMs: getStaleAfterMs() });
  const sessionData = job.status === "completed" ? loadSessionData(job.id) : null;

  return {
    schema_version: JOB_STATE_SCHEMA_VERSION,
    id: job.id,
    orchestration_state: derived.orchestrationState,
    status: job.status,
    process_state: derived.processState,
    turn_state: derived.turnState,
    blocker_kind: derived.blockerKind,
    turns_completed: derived.turnsCompleted,
    last_message: getLastMessage(job, sessionData),
    last_activity_at: getLastActivityAt(job, derived.lastActivityAt),
    usage: job.usage ?? loadDevinUsage(job.id),
    context: buildCompactContext(job),
    actions: {
      recommended_next: getRecommendedNext(derived.orchestrationState),
    },
    model: job.model,
    reasoning: job.reasoningEffort,
    sandbox: job.sandbox,
    cwd: job.cwd,
    created_at: job.createdAt,
    started_at: job.startedAt ?? null,
    completed_at: job.completedAt ?? null,
    error: job.error ?? null,
  };
}

export type StatusJsonOutput = {
  schema_version: typeof JOB_STATE_SCHEMA_VERSION;
  generated_at: string;
  job: CompactJobJson;
};

export function getStatusJson(jobId: string): StatusJsonOutput | null {
  const refreshed = refreshJobStatus(jobId);
  const job = refreshed ? persistDevinUsage(refreshed) : null;
  if (!job) return null;

  return {
    schema_version: JOB_STATE_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    job: buildCompactJobJson(job),
  };
}

export type JobsJsonEntry = {
  id: string;
  status: Job["status"];
  schema_version: typeof JOB_STATE_SCHEMA_VERSION;
  orchestration_state: OrchestrationState;
  process_state: ProcessState;
  turn_state: TurnState;
  blocker_kind: BlockerKind | null;
  turns_completed: number;
  last_message: string | null;
  last_activity_at: string | null;
  usage: DevinTokenUsage | null;
  context: CompactJobContext | null;
  actions: {
    recommended_next: string;
  };
  prompt_preview: string;
  elapsed_ms: number;
  model: string;
  reasoning: ReasoningEffort;
  sandbox: SandboxMode;
  cwd: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  files_modified: ParsedSessionData["files_modified"] | null;
  summary: string | null;
};

export type JobsJsonOutput = {
  schema_version: typeof JOB_STATE_SCHEMA_VERSION;
  generated_at: string;
  jobs: JobsJsonEntry[];
};

export function getJobsJson(options: ListJobsOptions = {}): JobsJsonOutput {
  const jobs = listJobs(options);
  const enriched = jobs.map((job) => {
    const refreshed = (job.status === "running" || job.status === "pending") ? refreshJobStatus(job.id) : null;
    const effective = persistDevinUsage(refreshed ?? job);
    const elapsedMs = computeElapsedMs(effective);
    const compact = buildCompactJobJson(effective);

    let filesModified: ParsedSessionData["files_modified"] | null = null;
    let summary: string | null = null;

    if (effective.status === "completed") {
      const sessionData = loadSessionData(effective.id);
      if (sessionData) {
        filesModified = sessionData.files_modified;
        summary = sessionData.summary ? truncateText(sessionData.summary, 500) : null;
      }
    }

    return {
      id: effective.id,
      status: effective.status,
      schema_version: compact.schema_version,
      orchestration_state: compact.orchestration_state,
      process_state: compact.process_state,
      turn_state: compact.turn_state,
      blocker_kind: compact.blocker_kind,
      turns_completed: compact.turns_completed,
      last_message: compact.last_message,
      last_activity_at: compact.last_activity_at,
      usage: compact.usage,
      context: compact.context,
      actions: compact.actions,
      prompt_preview: truncateText(effective.prompt, 100),
      elapsed_ms: elapsedMs,
      model: compact.model,
      reasoning: compact.reasoning,
      sandbox: compact.sandbox,
      cwd: compact.cwd,
      created_at: effective.createdAt,
      started_at: effective.startedAt ?? null,
      completed_at: effective.completedAt ?? null,
      error: effective.error ?? null,
      files_modified: filesModified,
      summary,
    };
  });

  const statusRank: Record<Job["status"], number> = {
    running: 0,
    pending: 1,
    failed: 2,
    completed: 3,
  };
  enriched.sort((a, b) => {
    const rankDiff = statusRank[a.status] - statusRank[b.status];
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const limit = options.all ? null : options.limit;
  const bounded = limit && limit > 0 ? enriched.slice(0, limit) : enriched;

  return {
    schema_version: JOB_STATE_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    jobs: bounded,
  };
}

export function deleteJob(jobId: string): boolean {
  const job = loadJob(jobId);

  // Kill tmux session if running
  if (job?.tmuxSession && sessionExists(job.tmuxSession)) {
    killSession(job.tmuxSession);
  }

  const archived = archiveJobArtifacts(jobId);
  if (archived.length === 0) return false;

  removeJobFromIndex(jobId);
  return true;
}

export interface StartJobOptions {
  prompt: string;
  promptContext?: PromptContextAccounting;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandbox?: SandboxMode;
  parentSessionId?: string;
  cwd?: string;
  cloud?: boolean;
  agentMode?: string;
}

export function startJob(options: StartJobOptions): Job {
  ensureJobsDir();
  cleanupCompletedSessions();

  const jobId = generateJobId();
  const cwd = options.cwd || process.cwd();

  const job: Job = {
    id: jobId,
    status: "pending",
    prompt: options.prompt,
    model: options.model || config.model,
    reasoningEffort: options.reasoningEffort || config.defaultReasoningEffort,
    sandbox: options.sandbox || config.defaultSandbox,
    parentSessionId: options.parentSessionId,
    cloud: options.cloud,
    agentMode: options.agentMode,
    cwd,
    createdAt: new Date().toISOString(),
    promptEstimatedTokens: options.promptContext?.estimatedTokens,
    promptBytes: options.promptContext?.bytes,
    promptContext: options.promptContext,
  };

  // Record the session name BEFORE creating it so orphan cleanup
  // never sees a live session without a matching job entry.
  const expectedSessionName = `${config.tmuxPrefix}-${jobId}`;
  job.tmuxSession = expectedSessionName;
  saveJob(job);

  // Create tmux session with devin
  const result = createSession({
    jobId,
    prompt: options.prompt,
    model: job.model,
    reasoningEffort: job.reasoningEffort,
    sandbox: job.sandbox,
    cwd,
    cloud: job.cloud,
    agentMode: job.agentMode,
  });

  if (result.success) {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.turnState = "working";
  } else {
    job.status = "failed";
    job.error = result.error || "Failed to create tmux session";
    job.completedAt = new Date().toISOString();
  }

  saveJob(job);
  return job;
}

export function killJob(jobId: string): boolean {
  const job = loadJob(jobId);
  if (!job) return false;

  // Kill tmux session
  if (job.tmuxSession) {
    killSession(job.tmuxSession);
  }

  clearSignalFile(jobId);
  job.status = "failed";
  job.error = "Killed by user";
  job.completedAt = new Date().toISOString();
  saveJob(job);
  return true;
}

export function sendToJob(jobId: string, message: string): boolean {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return false;

  const sent = sendMessage(job.tmuxSession, message);
  if (!sent) return false;

  // Clear turn-complete signal - agent will be working again
  clearSignalFile(jobId);
  job.turnState = "working";
  saveJob(job);

  return true;
}

export function sendControlToJob(jobId: string, key: string): boolean {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return false;

  return sendControl(job.tmuxSession, key);
}

export function getJobOutput(jobId: string, lines?: number): string | null {
  const job = loadJob(jobId);
  if (!job) return null;

  // First try tmux capture if session exists
  if (job.tmuxSession && sessionExists(job.tmuxSession)) {
    const output = capturePane(job.tmuxSession, { lines });
    if (output) return output;
  }

  // Fall back to log file
  const logFile = getJobArtifactPath(jobId, ".log");
  if (!logFile) return null;

  try {
    const content = readFileSync(logFile, "utf-8");
    if (lines) {
      const allLines = content.split("\n");
      return allLines.slice(-lines).join("\n");
    }
    return content;
  } catch {
    return null;
  }
}

export function getJobFullOutput(jobId: string): string | null {
  const job = loadJob(jobId);
  if (!job) return null;

  // First try tmux capture if session exists
  if (job.tmuxSession && sessionExists(job.tmuxSession)) {
    const output = captureFullHistory(job.tmuxSession);
    if (output) return output;
  }

  // Fall back to log file
  const logFile = getJobArtifactPath(jobId, ".log");
  if (!logFile) return null;

  try {
    return readFileSync(logFile, "utf-8");
  } catch {
    return null;
  }
}

export type CleanupResult = {
  jobsDeleted: number;
  orphanedSessionsKilled: number;
};

export function cleanupOldJobs(maxAgeDays: number = 7): CleanupResult {
  const jobs = listJobs({ all: true });
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let jobsDeleted = 0;

  const activeSessionNames = new Set(
    jobs
      .filter((job) => isActiveJobStatus(job.status) && job.tmuxSession)
      .map((job) => job.tmuxSession as string)
  );
  const orphanedSessionsKilled = cleanupOrphanedSessions(activeSessionNames).length;

  for (const job of jobs) {
    const jobTime = new Date(job.completedAt || job.createdAt).getTime();
    if (jobTime < cutoff && (job.status === "completed" || job.status === "failed")) {
      if (deleteJob(job.id)) jobsDeleted++;
    }
  }

  rebuildJobIndex();
  return {
    jobsDeleted,
    orphanedSessionsKilled,
  };
}

export function isJobRunning(jobId: string): boolean {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return false;

  return isSessionActive(job.tmuxSession);
}

export function refreshJobStatus(jobId: string): Job | null {
  const job = loadJob(jobId);
  if (!job) return null;

  // Repair pending jobs that got stuck
  if (job.status === "pending" && job.tmuxSession) {
    if (sessionExists(job.tmuxSession)) {
      const output = capturePane(job.tmuxSession, { lines: 20 });
      if (output && output.includes("[devin-agent: Session complete")) {
        job.status = "completed";
        job.completedAt = new Date().toISOString();
        saveJob(persistDevinUsage(job));
      } else {
        // Session is alive - promote to running
        job.status = "running";
        job.startedAt = job.startedAt || new Date().toISOString();
        job.turnState = "working";
        saveJob(persistDevinUsage(job));
      }
    } else {
      // No session and pending for >5 min = orphaned
      const ageMs = Date.now() - new Date(job.createdAt).getTime();
      if (ageMs > 5 * 60 * 1000) {
        job.status = "failed";
        job.error = "Orphaned pending job - no tmux session found";
        job.completedAt = new Date().toISOString();
        saveJob(persistDevinUsage(job));
      }
    }
    return loadJob(jobId);
  }

  if (job.status === "pending" && !job.tmuxSession) {
    // No session name recorded and pending for >5 min = failed
    const ageMs = Date.now() - new Date(job.createdAt).getTime();
    if (ageMs > 5 * 60 * 1000) {
      job.status = "failed";
      job.error = "Orphaned pending job - session never created";
      job.completedAt = new Date().toISOString();
      saveJob(persistDevinUsage(job));
    }
    return loadJob(jobId);
  }

  if (job.status === "running" && job.tmuxSession) {
    // Check if tmux session still exists
    if (!sessionExists(job.tmuxSession)) {
      // Session ended completely
      job.status = "completed";
      job.completedAt = new Date().toISOString();
      const logFile = getJobArtifactPath(jobId, ".log");
      try {
        if (logFile) {
          job.result = readFileSync(logFile, "utf-8");
        }
      } catch {
        // No log file
      }
      saveJob(persistDevinUsage(job));
    } else {
      const latestJob = loadJob(jobId);
      if (latestJob && latestJob.status !== "running") {
        return latestJob;
      }

      // Backward-compatible fallback for older leaked sessions that are still
      // waiting on the legacy completion prompt.
      const output = capturePane(job.tmuxSession, { lines: 20 });
      if (output && output.includes("[devin-agent: Session complete")) {
        job.status = "completed";
        job.completedAt = new Date().toISOString();
        // Capture full output
        const fullOutput = captureFullHistory(job.tmuxSession);
        if (fullOutput) {
          job.result = fullOutput;
        }
        saveJob(persistDevinUsage(job));
      } else if (isInactiveTimedOut(job)) {
        killSession(job.tmuxSession);
        job.status = "failed";
        job.error = `Timed out after ${config.defaultTimeout} minutes of inactivity`;
        job.completedAt = new Date().toISOString();
        saveJob(persistDevinUsage(job));
      }
    }
  }

  return persistDevinUsage(loadJob(jobId) ?? job);
}

export function isJobIdle(jobId: string): boolean {
  return signalFileExists(jobId);
}

export function getTurnSignal(jobId: string): TurnEvent | null {
  return readSignalFile(jobId);
}

export function getAttachCommand(jobId: string): string | null {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return null;

  return `tmux attach -t "${job.tmuxSession}"`;
}
