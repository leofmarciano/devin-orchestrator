#!/usr/bin/env bun

// Devin `Stop` lifecycle hook entrypoint.
//
// The job's generated Devin config registers this script as a `Stop` command
// hook (equivalent to Codex's `notify=[...]` turn-complete hook). Devin pipes
// the event payload to stdin:
//
//   {
//     "hook_event_name": "Stop",
//     "stop_hook_active": false,
//     "last_assistant_message": "...",
//     "session_id": "somber-accordion",
//     "prompt_id": "47c68cbe-..."
//   }
//
// Usage: bun run notify-hook.ts <jobId>        (payload on stdin)

import { updateJobTurn, writeSignalFile, type TurnEvent } from "./watcher.ts";

type HookPayload = {
  hook_event_name?: string;
  [key: string]: unknown;
};

function parsePayload(raw: string): HookPayload | null {
  try {
    return JSON.parse(raw) as HookPayload;
  } catch {
    return null;
  }
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toStringOrFallback(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function readStdin(): Promise<string> {
  // Fall back to argv[3] for parity with the Codex notify payload style.
  const argvPayload = process.argv[3];
  if (argvPayload) return argvPayload;

  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
  }
  return chunks.join("");
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) return;

  const rawPayload = (await readStdin()).trim();
  if (!rawPayload) return;

  const payload = parsePayload(rawPayload);
  if (!payload || payload.hook_event_name !== "Stop") return;

  const event: TurnEvent = {
    turnId: toStringOrFallback(payload.prompt_id) || toStringOrFallback(payload["turn-id"]),
    lastAgentMessage:
      toStringOrNull(payload.last_assistant_message) ??
      toStringOrNull(payload["last-assistant-message"]),
    timestamp: new Date().toISOString(),
    sessionId: toStringOrNull(payload.session_id),
  };

  writeSignalFile(jobId, event);
  updateJobTurn(jobId, event);
}

await main();
