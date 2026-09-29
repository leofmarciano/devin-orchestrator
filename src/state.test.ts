import { describe, expect, test } from "bun:test";
import { deriveJobView, normalizeJobLifecycle, type JobStateInput } from "./state.ts";

const baseJob: JobStateInput = {
  status: "running",
  createdAt: "2026-05-28T12:00:00.000Z",
  startedAt: "2026-05-28T12:00:05.000Z",
};

describe("job state derivation", () => {
  test("derives WAITING from running idle jobs with completed turns", () => {
    const view = deriveJobView({
      ...baseJob,
      turnState: "idle",
      turnsCompleted: 1,
    });

    expect(view.processState).toBe("running");
    expect(view.turnState).toBe("idle");
    expect(view.turnsCompleted).toBe(1);
    expect(view.orchestrationState).toBe("WAITING");
  });

  test("uses legacy turnCount for completed turn compatibility", () => {
    const view = deriveJobView({
      ...baseJob,
      turnState: "idle",
      turnCount: 2,
    });

    expect(view.turnsCompleted).toBe(2);
    expect(view.orchestrationState).toBe("WAITING");
  });

  test("uses legacy turnCount when turnsCompleted is stale", () => {
    const view = deriveJobView({
      ...baseJob,
      turnState: "idle",
      turnsCompleted: 0,
      turnCount: 1,
    });

    expect(view.processState).toBe("running");
    expect(view.turnState).toBe("idle");
    expect(view.turnsCompleted).toBe(1);
    expect(view.orchestrationState).toBe("WAITING");
  });

  test("normalizes terminal completed jobs away from working turns", () => {
    const lifecycle = normalizeJobLifecycle({
      ...baseJob,
      status: "completed",
      turnState: "working",
      turnsCompleted: 1,
      completedAt: "2026-05-28T12:03:00.000Z",
    });

    expect(lifecycle.processState).toBe("exited_success");
    expect(lifecycle.turnState).toBe("idle");
  });

  test("normalizes terminal failed jobs away from working turns", () => {
    const lifecycle = normalizeJobLifecycle({
      ...baseJob,
      status: "failed",
      turnState: "working",
      completedAt: "2026-05-28T12:03:00.000Z",
    });

    expect(lifecycle.processState).toBe("exited_failure");
    expect(lifecycle.turnState).toBe("failed");
  });

  test("normalizes cancelled jobs away from working turns", () => {
    const view = deriveJobView({
      ...baseJob,
      status: "failed",
      processState: "cancelled",
      turnState: "working",
      completedAt: "2026-05-28T12:03:00.000Z",
    });

    expect(view.processState).toBe("cancelled");
    expect(view.turnState).toBe("idle");
    expect(view.orchestrationState).toBe("CANCELLED");
  });

  test("derives context-limit legacy turn data as blocked", () => {
    const view = deriveJobView({
      ...baseJob,
      turnState: "context_limit",
      turnCount: 1,
    });

    expect(view.turnState).toBe("blocked");
    expect(view.blockerKind).toBe("context_limit");
    expect(view.orchestrationState).toBe("BLOCKED");
  });

  test("derives context-limit blocker data as blocked", () => {
    const view = deriveJobView({
      ...baseJob,
      turnState: "idle",
      blockerKind: "context_limit",
      turnsCompleted: 1,
    });

    expect(view.turnState).toBe("blocked");
    expect(view.blockerKind).toBe("context_limit");
    expect(view.orchestrationState).toBe("BLOCKED");
  });

  test("derives stale only for non-terminal jobs", () => {
    const runningView = deriveJobView(
      {
        ...baseJob,
        turnState: "working",
      },
      {
        nowMs: Date.parse("2026-05-28T12:10:00.000Z"),
        staleAfterMs: 60_000,
      }
    );
    const completedView = deriveJobView(
      {
        ...baseJob,
        status: "completed",
        turnState: "working",
        completedAt: "2026-05-28T12:00:10.000Z",
      },
      {
        nowMs: Date.parse("2026-05-28T12:10:00.000Z"),
        staleAfterMs: 60_000,
      }
    );

    expect(runningView.orchestrationState).toBe("STALE");
    expect(runningView.stale).toBe(true);
    expect(completedView.orchestrationState).toBe("COMPLETED");
    expect(completedView.stale).toBe(false);
  });
});
