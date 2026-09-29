import { describe, expect, test } from "bun:test";
import { parseAtifUsage, parseContextWindow } from "./metrics-parser.ts";

const ATIF_SAMPLE = JSON.stringify({
  schema_version: "ATIF-v1.7",
  session_id: "somber-accordion",
  agent: { name: "devin", version: "3000.11.3", model_name: "SWE-2 Medium" },
  steps: [
    {
      step_id: 1,
      timestamp: "2026-09-29T00:00:00Z",
      source: "user",
      message: "Say hi",
    },
    {
      step_id: 2,
      timestamp: "2026-09-29T00:00:05Z",
      source: "agent",
      message: "Hi!",
      metrics: { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 0 },
    },
  ],
  final_metrics: {
    total_prompt_tokens: 13640,
    total_completion_tokens: 5,
    total_cached_tokens: 5504,
    total_steps: 2,
  },
});

describe("parseAtifUsage", () => {
  test("parses final_metrics from an ATIF export", () => {
    expect(parseAtifUsage(ATIF_SAMPLE)).toEqual({
      total: 13645,
      input: 13640,
      cached_input: 5504,
      output: 5,
      steps: 2,
    });
  });

  test("returns null for invalid JSON", () => {
    expect(parseAtifUsage("not json")).toBeNull();
  });

  test("returns null when final_metrics is missing or incomplete", () => {
    expect(parseAtifUsage(JSON.stringify({ schema_version: "ATIF-v1.7" }))).toBeNull();
    expect(
      parseAtifUsage(JSON.stringify({ final_metrics: { total_prompt_tokens: 1 } })),
    ).toBeNull();
  });
});

describe("parseContextWindow", () => {
  test("parses the TUI context status bar", () => {
    expect(
      parseContextWindow("SWE-2 Medium    Context: 12k / 262k tokens (4%)"),
    ).toEqual({ context_window: 262000, context_used_pct: 4 });
  });

  test("uses the latest occurrence in the log", () => {
    const log = [
      "Context: 10k / 262k tokens (3%)",
      "some output",
      "Context: 55.5k / 262k tokens (21%)",
    ].join("\n");
    expect(parseContextWindow(log)).toEqual({ context_window: 262000, context_used_pct: 21 });
  });

  test("returns null when no context line is present", () => {
    expect(parseContextWindow("no context here")).toBeNull();
  });
});
