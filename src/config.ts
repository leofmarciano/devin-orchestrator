// Shared configuration for devin-agent

export const config = {
  // Default model family. Reasoning effort is composed into the model id
  // (e.g. swe-2 + high -> swe-2-high).
  model: "swe-2",
  reasoningEfforts: ["low", "medium", "high", "xhigh"] as const,
  defaultReasoningEffort: "medium" as const,
  // Accepts the codex-style names (mapped to Devin permission modes) plus the
  // native Devin permission-mode names.
  sandboxModes: [
    "read-only",
    "workspace-write",
    "danger-full-access",
    "auto",
    "accept-edits",
    "smart",
    "dangerous",
  ] as const,
  defaultSandbox: "workspace-write" as const,
  // Devin agent-modes (the /plan and /ask slash commands; "normal" is the
  // default Universal agent). Distinct from permission modes.
  agentModes: ["normal", "plan", "ask"] as const,
  defaultAgentMode: "normal" as const,
  jobsDir: `${process.env.HOME}/.devin-agent/jobs`,
  jobsIndexFile: `${process.env.HOME}/.devin-agent/jobs/index.json`,
  defaultTimeout: 60,
  jobsListLimit: 20,
  tmuxPrefix: "devin-agent",
};

export type ReasoningEffort = (typeof config.reasoningEfforts)[number];
export type SandboxMode = (typeof config.sandboxModes)[number];
export type AgentMode = (typeof config.agentModes)[number];
