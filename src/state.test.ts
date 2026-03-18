import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock config.js before importing state — vi.mock is hoisted automatically
vi.mock("./config.js", () => ({
  getProjectRoot: vi.fn(),
  loadConfig: vi.fn(),
}));

import { getProjectRoot } from "./config.js";
import { loadState, saveState, markReviewed, needsReview } from "./state.js";

const mockedGetProjectRoot = vi.mocked(getProjectRoot);

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "gthub-state-test-"));
  mkdirSync(join(testRoot, "state"), { recursive: true });
  mockedGetProjectRoot.mockReturnValue(testRoot);
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("loadState", () => {
  it("returns an empty state and creates the file when none exists", () => {
    const state = loadState();
    expect(state).toEqual({ reviewed: {} });
    expect(existsSync(join(testRoot, "state", "reviewed.json"))).toBe(true);
  });

  it("returns the persisted state when the file exists", () => {
    const data = { reviewed: { "owner/repo#1": { headSha: "abc", title: "Test", reviewedAt: "2026-01-01", reviewPath: "r.md", status: "complete" as const } } };
    writeFileSync(join(testRoot, "state", "reviewed.json"), JSON.stringify(data));
    expect(loadState()).toEqual(data);
  });

  it("backs up corrupt JSON and returns empty state instead of crashing", () => {
    const statePath = join(testRoot, "state", "reviewed.json");
    writeFileSync(statePath, "{ this is not valid json }}}");
    const state = loadState();
    expect(state).toEqual({ reviewed: {} });
    // The corrupt file should have been renamed
    expect(existsSync(`${statePath}.corrupt`)).toBe(true);
  });
});

describe("saveState / loadState round-trip", () => {
  it("persists and reloads state correctly", () => {
    const state = loadState();
    markReviewed(state, "owner/repo", 42, {
      headSha: "deadbeef",
      title: "My PR",
      reviewedAt: "2026-03-18T00:00:00.000Z",
      reviewPath: "reviews/owner-repo/PR-42/review.md",
      status: "complete",
    });
    saveState(state);

    const reloaded = loadState();
    expect(reloaded.reviewed["owner/repo#42"]).toMatchObject({
      headSha: "deadbeef",
      title: "My PR",
      status: "complete",
    });
  });

  it("does not leave a .tmp file after saving", () => {
    const state = loadState();
    saveState(state);
    expect(existsSync(join(testRoot, "state", "reviewed.json.tmp"))).toBe(false);
  });
});

describe("needsReview", () => {
  it("returns true for an unseen PR", () => {
    const state = loadState();
    expect(needsReview(state, "owner/repo", 1, "sha1")).toBe(true);
  });

  it("returns false for a PR already reviewed at the same SHA", () => {
    const state = loadState();
    markReviewed(state, "owner/repo", 1, { headSha: "sha1", title: "T", reviewedAt: "", reviewPath: "", status: "complete" });
    expect(needsReview(state, "owner/repo", 1, "sha1")).toBe(false);
  });

  it("returns true when the PR SHA has changed (new commit pushed)", () => {
    const state = loadState();
    markReviewed(state, "owner/repo", 1, { headSha: "sha1", title: "T", reviewedAt: "", reviewPath: "", status: "complete" });
    expect(needsReview(state, "owner/repo", 1, "sha2")).toBe(true);
  });
});
