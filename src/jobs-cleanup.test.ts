import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "./config.ts";
import { cleanupOldJobs, deleteJob, saveJob, type Job } from "./jobs.ts";

const originalJobsDir = config.jobsDir;
const originalJobsIndexFile = config.jobsIndexFile;
let tempRoot = "";

function setTempJobsDir(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "devin-agent-cleanup-"));
  config.jobsDir = join(tempRoot, ".devin-agent", "jobs");
  config.jobsIndexFile = join(config.jobsDir, "index.json");
  mkdirSync(config.jobsDir, { recursive: true });
  return tempRoot;
}

function jobFixture(overrides: Partial<Job> & Pick<Job, "id">): Job {
  return {
    id: overrides.id,
    status: "completed",
    prompt: "Test prompt",
    model: "swe-2",
    reasoningEffort: "low",
    sandbox: "workspace-write",
    cwd: "/tmp/project",
    createdAt: "2026-05-01T12:00:00.000Z",
    completedAt: "2026-05-01T12:05:00.000Z",
    turnState: "idle",
    ...overrides,
  };
}

function writeArtifacts(jobId: string): void {
  writeFileSync(join(config.jobsDir, `${jobId}.prompt`), "prompt");
  writeFileSync(join(config.jobsDir, `${jobId}.log`), "log");
  writeFileSync(join(config.jobsDir, `${jobId}.turn-complete`), "turn");
}

function trashDirs(): string[] {
  return readdirSync(join(config.jobsDir, ".trash"));
}

beforeEach(() => {
  setTempJobsDir();
});

afterEach(() => {
  config.jobsDir = originalJobsDir;
  config.jobsIndexFile = originalJobsIndexFile;
});

describe("job cleanup", () => {
  test("deleteJob archives job artifacts under the jobs home", () => {
    saveJob(jobFixture({ id: "deadbeef" }));
    writeArtifacts("deadbeef");

    expect(deleteJob("deadbeef")).toBe(true);

    for (const ext of [".json", ".prompt", ".log", ".turn-complete"]) {
      expect(existsSync(join(config.jobsDir, `deadbeef${ext}`))).toBe(false);
    }

    const archives = trashDirs();
    expect(archives).toHaveLength(1);
    const archiveDir = join(config.jobsDir, ".trash", archives[0]);
    for (const ext of [".json", ".prompt", ".log", ".turn-complete"]) {
      expect(existsSync(join(archiveDir, `deadbeef${ext}`))).toBe(true);
    }
  });

  test("deleteJob rejects traversal ids without touching external files", () => {
    const externalDir = join(tempRoot, "outside");
    mkdirSync(externalDir, { recursive: true });
    const externalFile = join(externalDir, "external.json");
    writeFileSync(externalFile, "do not move");

    expect(deleteJob("../../outside/external")).toBe(false);

    expect(existsSync(externalFile)).toBe(true);
    expect(readFileSync(externalFile, "utf-8")).toBe("do not move");
  });

  test("cleanupOldJobs archives old completed job artifacts instead of unlinking them", () => {
    saveJob(jobFixture({ id: "old-job", completedAt: "2000-01-01T00:00:00.000Z" }));
    writeArtifacts("old-job");
    saveJob(jobFixture({ id: "new-job", completedAt: new Date().toISOString() }));

    const result = cleanupOldJobs(7);

    expect(result.jobsDeleted).toBe(1);
    expect(existsSync(join(config.jobsDir, "old-job.json"))).toBe(false);
    expect(existsSync(join(config.jobsDir, "new-job.json"))).toBe(true);

    const archives = trashDirs();
    expect(archives).toHaveLength(1);
    expect(existsSync(join(config.jobsDir, ".trash", archives[0], "old-job.json"))).toBe(true);
  });
});
