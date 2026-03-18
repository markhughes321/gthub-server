import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { acquireLock, releaseLock, getLockInfo } from "./lock.js";

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "gthub-lock-test-"));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("returns true and creates a lock file when no lock exists", () => {
    const result = acquireLock(testRoot, "owner/repo", 1, "review-abc");
    expect(result).toBe(true);
    expect(existsSync(join(testRoot, "state", "locks", "owner-repo-PR1.lock"))).toBe(true);
  });

  it("returns false when the same PR is locked by the current live process", () => {
    acquireLock(testRoot, "owner/repo", 2, "review-first");
    const second = acquireLock(testRoot, "owner/repo", 2, "review-second");
    expect(second).toBe(false);
  });

  it("writes correct pid and reviewId into the lock file", () => {
    acquireLock(testRoot, "owner/repo", 3, "review-xyz");
    const info = getLockInfo(testRoot, "owner/repo", 3);
    expect(info?.pid).toBe(process.pid);
    expect(info?.reviewId).toBe("review-xyz");
    expect(info?.startedAt).toBeTruthy();
  });

  it("cleans up a stale lock from a dead PID and acquires successfully", () => {
    // Write a lock with a PID that definitely doesn't exist
    const lockDir = join(testRoot, "state", "locks");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner-repo-PR4.lock"),
      JSON.stringify({ pid: 999999999, startedAt: "2020-01-01", reviewId: "stale" })
    );

    const result = acquireLock(testRoot, "owner/repo", 4, "review-new");
    expect(result).toBe(true);

    const info = getLockInfo(testRoot, "owner/repo", 4);
    expect(info?.reviewId).toBe("review-new");
  });

  it("overwrites a corrupt lock file and acquires successfully", () => {
    const lockDir = join(testRoot, "state", "locks");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner-repo-PR5.lock"), "{ not valid json }}}");

    const result = acquireLock(testRoot, "owner/repo", 5, "review-ok");
    expect(result).toBe(true);
  });

  it("creates the locks directory if it doesn't exist", () => {
    acquireLock(testRoot, "owner/repo", 6, "review-dir-test");
    expect(existsSync(join(testRoot, "state", "locks"))).toBe(true);
  });
});

describe("releaseLock", () => {
  it("removes the lock file", () => {
    acquireLock(testRoot, "owner/repo", 10, "review-release");
    releaseLock(testRoot, "owner/repo", 10);
    expect(existsSync(join(testRoot, "state", "locks", "owner-repo-PR10.lock"))).toBe(false);
  });

  it("does not throw if the lock file does not exist", () => {
    expect(() => releaseLock(testRoot, "owner/repo", 99)).not.toThrow();
  });

  it("allows re-acquisition after release", () => {
    acquireLock(testRoot, "owner/repo", 11, "review-a");
    releaseLock(testRoot, "owner/repo", 11);
    const result = acquireLock(testRoot, "owner/repo", 11, "review-b");
    expect(result).toBe(true);
  });
});

describe("getLockInfo", () => {
  it("returns null when no lock exists", () => {
    expect(getLockInfo(testRoot, "owner/repo", 20)).toBeNull();
  });

  it("returns lock data when a lock exists", () => {
    acquireLock(testRoot, "owner/repo", 21, "review-info");
    const info = getLockInfo(testRoot, "owner/repo", 21);
    expect(info).not.toBeNull();
    expect(info?.reviewId).toBe("review-info");
  });
});
