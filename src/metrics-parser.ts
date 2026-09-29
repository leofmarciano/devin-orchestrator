// Token-usage extraction for Devin CLI sessions.
//
// Devin writes an ATIF export after each turn (see `devin --export`). Its
// `final_metrics` block carries cumulative token counters, which map onto the
// usage shape this tool reported for Codex sessions.
//
// The Devin TUI status bar also renders `Context: <used> / <window> tokens
// (<pct>%)`; parseContextWindow reads the latest occurrence from pane logs.

export type DevinTokenUsage = {
  total: number;
  input: number;
  cached_input: number;
  output: number;
  steps?: number;
};

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseAtifUsage(exportContent: string): DevinTokenUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(exportContent);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const metrics = (parsed as Record<string, unknown>).final_metrics;
  if (typeof metrics !== "object" || metrics === null) return null;

  const record = metrics as Record<string, unknown>;
  const input = toNumber(record.total_prompt_tokens);
  const output = toNumber(record.total_completion_tokens);
  if (input === null || output === null) return null;

  const cached = toNumber(record.total_cached_tokens) ?? 0;
  const steps = toNumber(record.total_steps);

  const usage: DevinTokenUsage = {
    total: input + output,
    input,
    cached_input: cached,
    output,
  };
  if (steps !== null) usage.steps = steps;
  return usage;
}

const CONTEXT_PATTERN =
  /Context:\s*([\d.,]+)\s*([kKmM]?)\s*\/\s*([\d.,]+)\s*([kKmM]?)\s*tokens\s*\(\s*([\d.]+)\s*%\s*\)/g;

function scaleTokenCount(raw: string, suffix: string): number | null {
  const value = Number.parseFloat(raw.replaceAll(",", ""));
  if (!Number.isFinite(value)) return null;
  const multiplier = suffix.toLowerCase() === "k" ? 1_000 : suffix.toLowerCase() === "m" ? 1_000_000 : 1;
  return Math.round(value * multiplier);
}

export type DevinContextWindow = {
  context_window: number;
  context_used_pct: number;
};

export function parseContextWindow(logContent: string): DevinContextWindow | null {
  let result: DevinContextWindow | null = null;

  for (const match of logContent.matchAll(CONTEXT_PATTERN)) {
    const window = scaleTokenCount(match[3], match[4] ?? "");
    const pct = Number.parseFloat(match[5]);
    if (window === null || !Number.isFinite(pct)) continue;
    result = { context_window: window, context_used_pct: pct };
  }

  return result;
}
