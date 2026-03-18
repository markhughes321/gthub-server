import { describe, it, expect } from "vitest";
import { classifyPR } from "./pr-classifier.js";

describe("classifyPR", () => {
  it("returns INFRA for an empty file list", () => {
    expect(classifyPR([])).toBe("INFRA");
  });

  it("returns UI for a src/tests/Ui/ file", () => {
    expect(classifyPR(["src/tests/Ui/LoginPage.spec.ts"])).toBe("UI");
  });

  it("returns UI for a src/pages/ file", () => {
    expect(classifyPR(["src/pages/Dashboard.ts"])).toBe("UI");
  });

  it("returns UI for a src/ui/ file", () => {
    expect(classifyPR(["src/ui/components/Button.ts"])).toBe("UI");
  });

  it("returns API for a src/tests/.../APITests/ file", () => {
    expect(classifyPR(["src/tests/Users/APITests/createUser.ts"])).toBe("API");
  });

  it("returns API for a src/api/ file", () => {
    expect(classifyPR(["src/api/users.ts"])).toBe("API");
  });

  it("returns MIXED when both API and UI files are present", () => {
    expect(classifyPR(["src/api/users.ts", "src/pages/UserList.ts"])).toBe("MIXED");
  });

  it("returns INFRA for playwright.config.ts", () => {
    expect(classifyPR(["playwright.config.ts"])).toBe("INFRA");
  });

  it("returns INFRA for src/config/ files", () => {
    expect(classifyPR(["src/config/env.ts"])).toBe("INFRA");
  });

  it("returns INFRA for src/utils/ files", () => {
    expect(classifyPR(["src/utils/helpers.ts"])).toBe("INFRA");
  });

  it("returns INFRA for .claude/ files", () => {
    expect(classifyPR([".claude/skills/pr-review.md"])).toBe("INFRA");
  });

  it("returns INFRA for unrecognised paths (falls through all patterns)", () => {
    expect(classifyPR(["random/unknown/file.ts"])).toBe("INFRA");
  });

  it("returns UI when mixed with INFRA-only files (INFRA does not elevate to MIXED)", () => {
    expect(classifyPR(["src/pages/Login.ts", "playwright.config.ts"])).toBe("UI");
  });

  it("returns API when mixed with INFRA-only files", () => {
    expect(classifyPR(["src/api/auth.ts", "src/utils/log.ts"])).toBe("API");
  });
});
