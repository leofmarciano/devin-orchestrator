import { describe, expect, test } from "bun:test";
import { buildDevinArgs, resolveDevinModel, resolvePermissionMode } from "./tmux.ts";

describe("devin launch args", () => {
  test("read-only sandbox maps to auto permission mode", () => {
    const args = buildDevinArgs({
      model: "swe-2",
      reasoningEffort: "low",
      sandbox: "read-only",
      configFile: "/tmp/job.devin-config.json",
      exportFile: "/tmp/job.atif.json",
    });

    expect(args).toContain("--model 'swe-2-medium'");
    expect(args).toContain("--permission-mode 'auto'");
    expect(args).toContain("--respect-workspace-trust false");
    expect(args).toContain("--config '/tmp/job.devin-config.json'");
    expect(args).toContain("--export '/tmp/job.atif.json'");
  });

  test("workspace-write sandbox maps to accept-edits permission mode", () => {
    const args = buildDevinArgs({
      model: "swe-2",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
      configFile: "/tmp/job.devin-config.json",
      exportFile: "/tmp/job.atif.json",
    });

    expect(args).toContain("--permission-mode 'accept-edits'");
    expect(args).toContain("--model 'swe-2-medium'");
  });

  test("danger-full-access maps to dangerous permission mode", () => {
    const args = buildDevinArgs({
      model: "swe-2",
      reasoningEffort: "high",
      sandbox: "danger-full-access",
      configFile: "/tmp/job.devin-config.json",
      exportFile: "/tmp/job.atif.json",
    });

    expect(args).toContain("--permission-mode 'dangerous'");
    expect(args).toContain("--model 'swe-2-high'");
  });

  test("cloud flag prepends --cloud to the launch args", () => {
    const args = buildDevinArgs({
      model: "swe-2",
      reasoningEffort: "low",
      sandbox: "workspace-write",
      configFile: "/tmp/job.devin-config.json",
      exportFile: "/tmp/job.atif.json",
      cloud: true,
    });

    expect(args).toMatch(/^--cloud /);
    expect(args).toContain("--model 'swe-2-medium'");
  });

  test("rejects malicious model text before building a shell command", () => {
    expect(() =>
      buildDevinArgs({
        model: `swe-2"; touch /tmp/devin-agent-pwn #`,
        reasoningEffort: "low",
        sandbox: "workspace-write",
        configFile: "/tmp/job.devin-config.json",
        exportFile: "/tmp/job.atif.json",
      }),
    ).toThrow(/Invalid Devin model name/);
  });
});

describe("resolveDevinModel", () => {
  test("swe-2 clamps efforts to the medium/high/max tiers", () => {
    expect(resolveDevinModel("swe-2", "low")).toBe("swe-2-medium");
    expect(resolveDevinModel("swe-2", "medium")).toBe("swe-2-medium");
    expect(resolveDevinModel("swe-2", "high")).toBe("swe-2-high");
    expect(resolveDevinModel("swe-2", "xhigh")).toBe("swe-2-max");
  });

  test("strips an existing effort suffix before composing", () => {
    expect(resolveDevinModel("swe-2-high", "xhigh")).toBe("swe-2-max");
    expect(resolveDevinModel("claude-opus-5.5-max", "medium")).toBe("claude-opus-5.5-medium");
  });

  test("other families get the suffix applied directly", () => {
    expect(resolveDevinModel("claude-sonnet-4.6", "xhigh")).toBe("claude-sonnet-4.6-xhigh");
  });
});

describe("resolvePermissionMode", () => {
  test("maps codex sandbox names and passes native modes through", () => {
    expect(resolvePermissionMode("read-only")).toBe("auto");
    expect(resolvePermissionMode("workspace-write")).toBe("accept-edits");
    expect(resolvePermissionMode("danger-full-access")).toBe("dangerous");
    expect(resolvePermissionMode("smart")).toBe("smart");
    expect(resolvePermissionMode("dangerous")).toBe("dangerous");
  });
});
