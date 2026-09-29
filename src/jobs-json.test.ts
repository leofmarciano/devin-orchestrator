import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "./config.ts";
import { buildPromptContext } from "./prompt-context.ts";
import { getJobsJson, getStatusJson, saveJob, type Job } from "./jobs.ts";
import { updateJobTurn } from "./watcher.ts";

const originalJobsDir = config.jobsDir;
const originalJobsIndexFile = config.jobsIndexFile;

function setTempJobsDir(): string {
  const root = mkdtempSync(join(tmpdir(), "devin-agent-jobs-json-"));
  config.jobsDir = join(root, ".devin-agent", "jobs");
  config.jobsIndexFile = join(config.jobsDir, "index.json");
  mkdirSync(config.jobsDir, { recursive: true });
  return root;
}

function jobFixture(overrides: Partial<Job> & Pick<Job, "id">): Job {
  return {
    id: overrides.id,
    status: "running",
    prompt: "Test prompt",
    model: "swe-2",
    reasoningEffort: "low",
    sandbox: "workspace-write",
    cwd: "/tmp/project",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    startedAt: new Date(Date.now() - 59_000).toISOString(),
    turnState: "working",
    ...overrides,
  };
}

beforeEach(() => {
  setTempJobsDir();
});

afterEach(() => {
  config.jobsDir = originalJobsDir;
  config.jobsIndexFile = originalJobsIndexFile;
});

describe("job JSON contract", () => {
  test("status JSON exposes compact derived state, usage, context, and actions", async () => {
    const promptContext = await buildPromptContext({
      taskPrompt: "Implement the thing.",
      includeMap: true,
      mapContent: ["---", "total_tokens: 9,094", "---", "", "# Map"].join("\n"),
      mapPath: "/tmp/project/docs/CODEBASE_MAP.md",
    });

    saveJob(
      jobFixture({
        id: "waiting",
        prompt: promptContext.prompt,
        promptContext: promptContext.accounting,
        promptEstimatedTokens: promptContext.accounting.estimatedTokens,
        promptBytes: promptContext.accounting.bytes,
        turnState: "idle",
        turnsCompleted: 1,
        lastAgentMessage: "Ready for parent input.",
        lastTurnCompletedAt: new Date(Date.now() - 10_000).toISOString(),
      }),
    );
    writeFileSync(
      join(config.jobsDir, "waiting.atif.json"),
      JSON.stringify({
        schema_version: "ATIF-v1.7",
        session_id: "somber-accordion",
        steps: [],
        final_metrics: {
          total_prompt_tokens: 13640,
          total_completion_tokens: 5,
          total_cached_tokens: 5504,
          total_steps: 2,
        },
      }),
    );

    const payload = getStatusJson("waiting");

    expect(payload?.schema_version).toBe("devin-agent.job.v1");
    expect(payload?.job).toMatchObject({
      id: "waiting",
      schema_version: "devin-agent.job.v1",
      orchestration_state: "WAITING",
      status: "running",
      process_state: "running",
      turn_state: "idle",
      blocker_kind: null,
      turns_completed: 1,
      last_message: "Ready for parent input.",
      usage: {
        total: 13645,
        input: 13640,
        cached_input: 5504,
        output: 5,
        steps: 2,
      },
      actions: {
        recommended_next: "send_or_close",
      },
    });
    expect(payload?.job.context).toMatchObject({
      prompt_estimated_tokens: promptContext.accounting.estimatedTokens,
      prompt_bytes: promptContext.accounting.bytes,
      map: {
        included: true,
        path: "/tmp/project/docs/CODEBASE_MAP.md",
        estimated_tokens: promptContext.accounting.map.estimatedTokens,
        cartographer_total_tokens: 9094,
      },
    });
    expect(payload?.job.context?.components.map((component) => component.kind)).toEqual([
      "map_wrapper",
      "codebase_map",
      "task_prompt",
    ]);

    const savedJob = JSON.parse(readFileSync(join(config.jobsDir, "waiting.json"), "utf-8"));
    expect(savedJob.usage).toEqual({
      total: 13645,
      input: 13640,
      cached_input: 5504,
      output: 5,
      steps: 2,
    });
  });

  test("jobs JSON limit returns exactly N entries unless all is passed", () => {
    for (let index = 0; index < 5; index += 1) {
      saveJob(
        jobFixture({
          id: `job-${index}`,
          createdAt: new Date(Date.now() - 60_000 + index * 1000).toISOString(),
          startedAt: new Date(Date.now() - 55_000 + index * 1000).toISOString(),
        }),
      );
    }

    const limited = getJobsJson({ limit: 3 });
    const all = getJobsJson({ all: true, limit: 3 });

    expect(limited.jobs).toHaveLength(3);
    expect(all.jobs).toHaveLength(5);
    expect(limited.jobs.every((job) => job.schema_version === "devin-agent.job.v1")).toBe(true);
    expect(limited.jobs.every((job) => job.orchestration_state === "WORKING")).toBe(true);
    expect(limited.jobs.every((job) => job.actions.recommended_next === "await_turn")).toBe(true);
  });

  test("turn completion update keeps turnsCompleted in sync with legacy turnCount", () => {
    saveJob(
      jobFixture({
        id: "notify",
        turnState: "working",
        turnsCompleted: 0,
        turnCount: 0,
      }),
    );

    const turnTimestamp = new Date().toISOString();
    updateJobTurn("notify", {
      turnId: "turn-1",
      lastAgentMessage: "OK",
      timestamp: turnTimestamp,
    });

    const job = JSON.parse(readFileSync(join(config.jobsDir, "notify.json"), "utf-8"));

    expect(job.turnState).toBe("idle");
    expect(job.turnCount).toBe(1);
    expect(job.turnsCompleted).toBe(1);
    expect(job.lastAgentMessage).toBe("OK");
    expect(job.lastTurnCompletedAt).toBe(turnTimestamp);
  });
});
