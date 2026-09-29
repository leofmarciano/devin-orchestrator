export const JOB_STATE_SCHEMA_VERSION = "devin-agent.job.v1";

export type ProcessState =
  | "created"
  | "starting"
  | "running"
  | "exiting"
  | "exited_success"
  | "exited_failure"
  | "cancelled";

export type TurnState = "none" | "starting" | "working" | "idle" | "blocked" | "failed";

export type LegacyTurnState = TurnState | "context_limit";

export type BlockerKind =
  | "auth"
  | "onboarding"
  | "permission"
  | "context_limit"
  | "no_active_thread"
  | "preflight"
  | "tooling"
  | "unknown";

export type OrchestrationState =
  | "PENDING"
  | "STARTING"
  | "WORKING"
  | "WAITING"
  | "BLOCKED"
  | "STALE"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

type LegacyJobStatus = "pending" | "running" | "completed" | "failed";

export interface JobStateInput {
  status?: LegacyJobStatus;
  processState?: ProcessState;
  turnState?: LegacyTurnState;
  blockerKind?: BlockerKind | null;
  turnCount?: number;
  turnsCompleted?: number;
  tmuxSession?: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  lastTurnCompletedAt?: string;
}

export interface NormalizedJobLifecycle {
  processState: ProcessState;
  turnState: TurnState;
  blockerKind: BlockerKind | null;
  turnsCompleted: number;
}

export interface DerivedJobView extends NormalizedJobLifecycle {
  orchestrationState: OrchestrationState;
  lastActivityAt: string | null;
  stale: boolean;
}

export interface DeriveJobViewOptions {
  nowMs?: number;
  staleAfterMs?: number | null;
}

const PROCESS_STATES = new Set<ProcessState>([
  "created",
  "starting",
  "running",
  "exiting",
  "exited_success",
  "exited_failure",
  "cancelled",
]);

const TURN_STATES = new Set<TurnState>([
  "none",
  "starting",
  "working",
  "idle",
  "blocked",
  "failed",
]);

const BLOCKER_KINDS = new Set<BlockerKind>([
  "auth",
  "onboarding",
  "permission",
  "context_limit",
  "no_active_thread",
  "preflight",
  "tooling",
  "unknown",
]);

function isProcessState(value: unknown): value is ProcessState {
  return typeof value === "string" && PROCESS_STATES.has(value as ProcessState);
}

function isTurnState(value: unknown): value is TurnState {
  return typeof value === "string" && TURN_STATES.has(value as TurnState);
}

function isBlockerKind(value: unknown): value is BlockerKind {
  return typeof value === "string" && BLOCKER_KINDS.has(value as BlockerKind);
}

function isTerminalProcessState(processState: ProcessState): boolean {
  return (
    processState === "exited_success" ||
    processState === "exited_failure" ||
    processState === "cancelled"
  );
}

function normalizeTurnsCompleted(job: JobStateInput): number {
  const turnsCompleted =
    Number.isFinite(job.turnsCompleted) && job.turnsCompleted > 0
      ? Math.floor(job.turnsCompleted)
      : 0;
  const turnCount =
    Number.isFinite(job.turnCount) && job.turnCount > 0 ? Math.floor(job.turnCount) : 0;
  const value = Math.max(turnsCompleted, turnCount);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function normalizeJobProcessState(job: JobStateInput): ProcessState {
  if (job.status === "completed") return "exited_success";
  if (job.status === "failed") {
    return job.processState === "cancelled" ? "cancelled" : "exited_failure";
  }
  if (job.status === "pending") {
    return job.startedAt || job.tmuxSession ? "starting" : "created";
  }
  if (job.status === "running") return "running";

  if (isProcessState(job.processState)) return job.processState;
  return "created";
}

export function normalizeJobLifecycle<T extends JobStateInput>(
  job: T
): T & NormalizedJobLifecycle {
  const processState = normalizeJobProcessState(job);
  const turnsCompleted = normalizeTurnsCompleted(job);
  const hasContextLimit =
    job.turnState === "context_limit" || job.blockerKind === "context_limit";
  const blockerKind = hasContextLimit
    ? "context_limit"
    : isBlockerKind(job.blockerKind)
      ? job.blockerKind
      : null;
  let turnState: TurnState;

  if (processState === "exited_success" || processState === "cancelled") {
    turnState = job.turnState === "failed" ? "failed" : "idle";
  } else if (processState === "exited_failure") {
    turnState = "failed";
  } else if (hasContextLimit || blockerKind) {
    turnState = "blocked";
  } else if (isTurnState(job.turnState)) {
    turnState = job.turnState;
  } else if (processState === "created") {
    turnState = "none";
  } else if (processState === "starting") {
    turnState = "starting";
  } else {
    turnState = "working";
  }

  return {
    ...job,
    processState,
    turnState,
    blockerKind,
    turnsCompleted,
  };
}

function parseIsoMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getLastActivityAt(job: JobStateInput): string | null {
  const candidates = [
    job.completedAt,
    job.lastTurnCompletedAt,
    job.startedAt,
    job.createdAt,
  ].filter((value): value is string => typeof value === "string");

  let latest: string | null = null;
  let latestMs = -Infinity;

  for (const candidate of candidates) {
    const candidateMs = parseIsoMs(candidate);
    if (candidateMs !== null && candidateMs > latestMs) {
      latest = candidate;
      latestMs = candidateMs;
    }
  }

  return latest;
}

function isStale(job: JobStateInput, processState: ProcessState, options: DeriveJobViewOptions): boolean {
  if (isTerminalProcessState(processState)) return false;
  if (!options.staleAfterMs || options.staleAfterMs <= 0) return false;

  const lastActivityAt = getLastActivityAt(job);
  const lastActivityMs = parseIsoMs(lastActivityAt ?? undefined);
  if (lastActivityMs === null) return false;

  const nowMs = options.nowMs ?? Date.now();
  return nowMs - lastActivityMs > options.staleAfterMs;
}

function deriveOrchestrationState(
  lifecycle: NormalizedJobLifecycle,
  stale: boolean
): OrchestrationState {
  if (lifecycle.processState === "cancelled") return "CANCELLED";
  if (lifecycle.processState === "exited_success") return "COMPLETED";
  if (lifecycle.processState === "exited_failure") return "FAILED";
  if (lifecycle.processState === "created") return "PENDING";
  if (lifecycle.processState === "starting") return "STARTING";
  if (lifecycle.turnState === "failed") return "FAILED";
  if (lifecycle.turnState === "blocked") return "BLOCKED";
  if (stale) return "STALE";
  if (lifecycle.turnState === "idle" && lifecycle.turnsCompleted > 0) return "WAITING";
  if (lifecycle.turnState === "starting") return "STARTING";
  return "WORKING";
}

export function deriveJobView(
  job: JobStateInput,
  options: DeriveJobViewOptions = {}
): DerivedJobView {
  const lifecycle = normalizeJobLifecycle(job);
  const stale = isStale(job, lifecycle.processState, options);

  return {
    ...lifecycle,
    orchestrationState: deriveOrchestrationState(lifecycle, stale),
    lastActivityAt: getLastActivityAt(job),
    stale,
  };
}
