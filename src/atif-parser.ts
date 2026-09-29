// ATIF export parser for Devin CLI sessions.
//
// devin-agent launches every job with `devin --export <jobId>.atif.json`. The
// CLI rewrites that file after each turn with the full trajectory:
//
//   {
//     "schema_version": "ATIF-v1.7",
//     "session_id": "somber-accordion",
//     "agent": { "name": "devin", "version": "...", "model_name": "SWE-2 Medium", ... },
//     "steps": [ { "step_id", "timestamp", "source", "message",
//                  "tool_calls"?, "metrics"? , ... } ],
//     "final_metrics": { "total_prompt_tokens", "total_completion_tokens",
//                        "total_cached_tokens", "total_steps" }
//   }
//
// This module derives the same ParsedSessionData the Codex session parser
// produced: token totals, files modified, and the last agent message.

import { readFileSync } from "fs";

export type SessionTokens = {
  input: number;
  output: number;
  context_window: number | null;
  context_used_pct: number | null;
};

export type ParsedSessionData = {
  tokens: SessionTokens | null;
  files_modified: string[] | null;
  summary: string | null;
  session_id: string | null;
};

// Devin tool names whose arguments carry a target file path.
const FILE_WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "notebook_edit"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractPathFromArguments(args: unknown): string | null {
  if (!isRecord(args)) return null;
  for (const key of ["file_path", "path", "notebook_path", "filename", "file"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function extractFilesFromPatchText(patchText: string): string[] {
  const files: string[] = [];
  const prefixes = [
    "*** Update File: ",
    "*** Add File: ",
    "*** Delete File: ",
    "*** Move to: ",
  ];

  for (const line of patchText.split("\n")) {
    for (const prefix of prefixes) {
      if (!line.startsWith(prefix)) continue;
      const file = line.slice(prefix.length).trim();
      if (file) files.push(file);
    }
  }

  return files;
}

function extractFilesFromToolCall(toolCall: unknown): string[] {
  if (!isRecord(toolCall)) return [];

  const name =
    typeof toolCall.function_name === "string"
      ? toolCall.function_name
      : typeof toolCall.name === "string"
        ? toolCall.name
        : null;
  if (!name || !FILE_WRITE_TOOLS.has(name)) return [];

  const files: string[] = [];
  const args = toolCall.arguments ?? toolCall.input;
  const directPath = extractPathFromArguments(args);
  if (directPath) files.push(directPath);

  if (isRecord(args)) {
    for (const value of Object.values(args)) {
      if (typeof value === "string" && value.includes("*** ")) {
        files.push(...extractFilesFromPatchText(value));
      }
    }
  }

  return files;
}

function extractAgentMessage(step: Record<string, unknown>): string | null {
  const message = step.message;
  if (typeof message === "string" && message.trim()) return message;
  if (Array.isArray(message)) {
    const parts: string[] = [];
    for (const part of message) {
      if (typeof part === "string") parts.push(part);
      else if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
    }
    if (parts.length > 0) return parts.join("");
  }
  return null;
}

export function parseAtifExport(exportContent: string): ParsedSessionData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(exportContent);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const filesModified = new Set<string>();
  let summary: string | null = null;
  let tokens: SessionTokens | null = null;

  const metrics = isRecord(parsed.final_metrics) ? parsed.final_metrics : null;
  if (metrics) {
    const input = toNumber(metrics.total_prompt_tokens);
    const output = toNumber(metrics.total_completion_tokens);
    if (input !== null && output !== null) {
      tokens = {
        input,
        output,
        context_window: null,
        context_used_pct: null,
      };
    }
  }

  const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  for (const step of steps) {
    if (!isRecord(step)) continue;

    if (step.source === "agent" || step.source === "assistant") {
      const message = extractAgentMessage(step);
      if (message) summary = message;
    }

    const toolCalls = step.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        for (const file of extractFilesFromToolCall(call)) {
          filesModified.add(file);
        }
      }
    }
  }

  const sessionId =
    typeof parsed.session_id === "string" && parsed.session_id.trim()
      ? parsed.session_id
      : null;

  return {
    tokens,
    files_modified: Array.from(filesModified),
    summary,
    session_id: sessionId,
  };
}

export function parseAtifFile(path: string): ParsedSessionData | null {
  try {
    return parseAtifExport(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\[[\d;]*m/g, "");
}

/**
 * Devin session ids are slugs like "somber-accordion" (or UUIDs). They appear
 * in hook payloads and ATIF exports as `"session_id":"..."` — also match the
 * bare `session id: x` / `session_id: x` style for log scraping.
 */
export function extractSessionId(logContent: string): string | null {
  const cleanContent = stripAnsiCodes(logContent);

  const patterns = [
    /"session_id"\s*:\s*"([a-z0-9-]{4,})"/i,
    /session id:\s*([0-9a-f-]{8,})/i,
    /session_id[:=]\s*([0-9a-z-]{4,})/i,
    /sessionId["\s:=]*([0-9a-z-]{4,})/i,
  ];

  for (const pattern of patterns) {
    const match = cleanContent.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}
