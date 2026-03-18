import { describe, it, expect } from "vitest";
import { redactSecrets, parseStreamJsonLine } from "./reviewer.js";

describe("redactSecrets", () => {
  it("redacts github_pat_ tokens", () => {
    expect(redactSecrets("token github_pat_ABC123_xyz rest")).toBe("token [REDACTED] rest");
  });

  it("redacts ghp_ tokens", () => {
    expect(redactSecrets("Bearer ghp_abc123DEF")).toBe("Bearer [REDACTED]");
  });

  it("redacts ghs_ tokens", () => {
    expect(redactSecrets("ghs_someServerToken99")).toBe("[REDACTED]");
  });

  it("redacts GH_TOKEN= env var form", () => {
    expect(redactSecrets("GH_TOKEN=mysecrettoken")).toBe("GH_TOKEN=[REDACTED]");
  });

  it("redacts GITHUB_PAT= env var form", () => {
    expect(redactSecrets("GITHUB_PAT=mysecrettoken")).toBe("GITHUB_PAT=[REDACTED]");
  });

  it("redacts GITHUB_TOKEN= env var form", () => {
    expect(redactSecrets("GITHUB_TOKEN=mysecrettoken")).toBe("GITHUB_TOKEN=[REDACTED]");
  });

  it("redacts token embedded mid-sentence", () => {
    const input = "running with token=ghp_abc123 in the pipeline";
    expect(redactSecrets(input)).toBe("running with token=[REDACTED] in the pipeline");
  });

  it("leaves a string with no secrets unchanged", () => {
    const safe = "No secrets here, just normal text.";
    expect(redactSecrets(safe)).toBe(safe);
  });

  it("redacts multiple tokens in one string", () => {
    const input = "ghp_first and ghp_second";
    expect(redactSecrets(input)).toBe("[REDACTED] and [REDACTED]");
  });
});

describe("parseStreamJsonLine", () => {
  it("returns empty strings for an empty line", () => {
    expect(parseStreamJsonLine("")).toEqual({ display: "", fileText: "" });
  });

  it("returns empty strings for invalid JSON", () => {
    expect(parseStreamJsonLine("not json at all")).toEqual({ display: "", fileText: "" });
  });

  it("returns empty strings for unhandled event types", () => {
    const line = JSON.stringify({ type: "system", message: "hello" });
    expect(parseStreamJsonLine(line)).toEqual({ display: "", fileText: "" });
  });

  it("extracts text from an assistant event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Here is my review." }] },
    });
    const { display, fileText } = parseStreamJsonLine(line);
    expect(display).toBe("Here is my review.");
    expect(fileText).toBe("");
  });

  it("formats a tool_use block with a command input", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }],
      },
    });
    const { display } = parseStreamJsonLine(line);
    expect(display).toContain("▶ Bash: git status");
  });

  it("formats a tool_use block with a path input", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { path: "src/index.ts" } }],
      },
    });
    const { display } = parseStreamJsonLine(line);
    expect(display).toContain("▶ Read: src/index.ts");
  });

  it("falls back to JSON-stringified input when no command or path", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Glob", input: { pattern: "**/*.ts" } }],
      },
    });
    const { display } = parseStreamJsonLine(line);
    expect(display).toContain("▶ Glob:");
    expect(display).toContain("pattern");
  });

  it("extracts fileText from a result event", () => {
    const line = JSON.stringify({ type: "result", result: "## Review\nLooks good." });
    const { display, fileText } = parseStreamJsonLine(line);
    expect(display).toBe("");
    expect(fileText).toBe("## Review\nLooks good.");
  });

  it("truncates tool_result content at 600 chars", () => {
    const longText = "x".repeat(700);
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", content: longText }],
      },
    });
    const { display } = parseStreamJsonLine(line);
    expect(display.length).toBeLessThan(700);
    expect(display).toContain("…");
  });

  it("redacts secrets inside assistant display output", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "token: ghp_secret123" }] },
    });
    const { display } = parseStreamJsonLine(line);
    expect(display).not.toContain("ghp_secret123");
    expect(display).toContain("[REDACTED]");
  });
});
