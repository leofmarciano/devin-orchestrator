import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { estimateTokens } from "./files.ts";
import {
  buildPromptContext,
  estimatePromptText,
  readCartographerMapMetadata,
} from "./prompt-context.ts";

describe("readCartographerMapMetadata", () => {
  test("reads total_tokens from Cartographer frontmatter", () => {
    const map = [
      "---",
      "last_mapped: 2026-01-16T21:00:00Z",
      "total_files: 8",
      "total_tokens: 9,094",
      "---",
      "",
      "# Codebase Map",
    ].join("\n");

    expect(readCartographerMapMetadata(map)).toEqual({ totalTokens: 9094 });
  });

  test("returns null metadata when total_tokens is absent", () => {
    expect(readCartographerMapMetadata("# Codebase Map")).toEqual({ totalTokens: null });
  });
});

describe("buildPromptContext", () => {
  test("accounts for a task prompt without a map", async () => {
    const taskPrompt = "Implement the narrow helper.";
    const result = await buildPromptContext({ taskPrompt });

    expect(result.prompt).toBe(taskPrompt);
    expect(result.accounting.bytes).toBe(Buffer.byteLength(taskPrompt, "utf8"));
    expect(result.accounting.estimatedTokens).toBe(estimateTokens(taskPrompt));
    expect(result.accounting.taskPrompt).toEqual(estimatePromptText(taskPrompt));
    expect(result.accounting.map).toEqual({
      included: false,
      path: null,
      bytes: 0,
      estimatedTokens: 0,
      cartographerTotalTokens: null,
    });
    expect(result.accounting.components.map((component) => component.kind)).toEqual(["task_prompt"]);
  });

  test("keeps map estimated tokens separate from Cartographer metadata total_tokens", async () => {
    const taskPrompt = "Build the feature.";
    const map = [
      "---",
      "total_tokens: 12000",
      "---",
      "",
      "# Codebase Map",
      "Short map body.",
    ].join("\n");

    const result = await buildPromptContext({
      taskPrompt,
      includeMap: true,
      mapContent: map,
      mapPath: "/tmp/CODEBASE_MAP.md",
    });

    expect(result.prompt).toBe(`## Codebase Map\n\n${map}\n\n---\n\n${taskPrompt}`);
    expect(result.accounting.map).toEqual({
      included: true,
      path: "/tmp/CODEBASE_MAP.md",
      bytes: Buffer.byteLength(map, "utf8"),
      estimatedTokens: estimateTokens(map),
      cartographerTotalTokens: 12000,
    });
    expect(result.accounting.taskPrompt).toEqual(estimatePromptText(taskPrompt));
    expect(result.accounting.estimatedTokens).toBe(estimateTokens(result.prompt));
    expect(result.accounting.map.estimatedTokens).not.toBe(
      result.accounting.map.cartographerTotalTokens,
    );
    expect(result.accounting.components.map((component) => component.kind)).toEqual([
      "map_wrapper",
      "codebase_map",
      "task_prompt",
    ]);
  });

  test("can load a Cartographer map from the standard docs path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "devin-agent-prompt-context-"));
    const docsDir = join(cwd, "docs");
    mkdirSync(docsDir);

    const map = [
      "---",
      "total_tokens: 42",
      "---",
      "",
      "# Loaded Map",
    ].join("\n");
    const mapPath = join(docsDir, "CODEBASE_MAP.md");
    writeFileSync(mapPath, map);

    const result = await buildPromptContext({
      taskPrompt: "Use the loaded map.",
      includeMap: true,
      cwd,
    });

    expect(result.accounting.map.included).toBe(true);
    expect(result.accounting.map.path).toBe(mapPath);
    expect(result.accounting.map.estimatedTokens).toBe(estimateTokens(map));
    expect(result.accounting.map.cartographerTotalTokens).toBe(42);
  });
});
