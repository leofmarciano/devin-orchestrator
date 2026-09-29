import { readFileSync, writeFileSync, unlinkSync, statSync } from "fs";
import { resolve, sep } from "path";
import { config } from "./config.ts";

export interface TurnEvent {
  turnId: string;
  lastAgentMessage: string | null;
  timestamp: string;
  sessionId?: string | null;
}

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isUnderJobsDir(filePath: string): boolean {
  const jobsDir = resolve(config.jobsDir);
  const resolved = resolve(filePath);
  return resolved === jobsDir || resolved.startsWith(`${jobsDir}${sep}`);
}

function getArtifactPath(jobId: string, extension: string): string | null {
  if (!JOB_ID_PATTERN.test(jobId)) return null;

  const artifactPath = resolve(config.jobsDir, `${jobId}${extension}`);
  return isUnderJobsDir(artifactPath) ? artifactPath : null;
}

function getSignalPath(jobId: string): string | null {
  return getArtifactPath(jobId, ".turn-complete");
}

export function writeSignalFile(jobId: string, event: TurnEvent): void {
  const signalPath = getSignalPath(jobId);
  if (!signalPath) return;

  writeFileSync(signalPath, JSON.stringify(event));
}

export function readSignalFile(jobId: string): TurnEvent | null {
  const signalPath = getSignalPath(jobId);
  if (!signalPath) return null;

  try {
    const content = readFileSync(signalPath, "utf-8");
    return JSON.parse(content) as TurnEvent;
  } catch {
    return null;
  }
}

export function clearSignalFile(jobId: string): void {
  const signalPath = getSignalPath(jobId);
  if (!signalPath) return;

  try {
    unlinkSync(signalPath);
  } catch {
    // File may not exist
  }
}

export function signalFileExists(jobId: string): boolean {
  const signalPath = getSignalPath(jobId);
  if (!signalPath) return false;

  try {
    statSync(signalPath);
    return true;
  } catch {
    return false;
  }
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function normalizeCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function updateJobTurn(jobId: string, event: TurnEvent): void {
  const jobPath = getArtifactPath(jobId, ".json");
  if (!jobPath) return;

  try {
    const job = JSON.parse(readFileSync(jobPath, "utf-8"));
    const turnsCompleted =
      Math.max(normalizeCounter(job.turnsCompleted), normalizeCounter(job.turnCount)) + 1;
    job.turnCount = turnsCompleted;
    job.turnsCompleted = turnsCompleted;
    job.lastTurnCompletedAt = event.timestamp;
    job.lastAgentMessage = event.lastAgentMessage
      ? truncateText(event.lastAgentMessage, 500)
      : null;
    job.turnState = "idle";
    if (event.sessionId) {
      job.devinSessionId = event.sessionId;
    }
    writeFileSync(jobPath, JSON.stringify(job, null, 2));
  } catch {
    // Job file may not exist or be corrupt - skip silently
  }
}

export function setJobTurnWorking(jobId: string): void {
  const jobPath = getArtifactPath(jobId, ".json");
  if (!jobPath) return;

  try {
    const job = JSON.parse(readFileSync(jobPath, "utf-8"));
    job.turnState = "working";
    writeFileSync(jobPath, JSON.stringify(job, null, 2));
  } catch {
    // Skip silently
  }
}
