import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  existsSync,
} from "fs";
import { join } from "path";

interface LockData {
  pid: number;
  startedAt: string;
  reviewId: string;
}

function getLockPath(projectRoot: string, repo: string, prNumber: number): string {
  const safeRepo = repo.replace(/\//g, "-");
  return join(projectRoot, "state", "locks", `${safeRepo}-PR${prNumber}.lock`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to acquire an exclusive lock for reviewing a PR.
 * Returns true if the lock was acquired, false if another process holds it.
 * Stale locks (from crashed processes) are automatically cleaned up.
 */
export function acquireLock(
  projectRoot: string,
  repo: string,
  prNumber: number,
  reviewId: string
): boolean {
  const lockDir = join(projectRoot, "state", "locks");
  if (!existsSync(lockDir)) {
    mkdirSync(lockDir, { recursive: true });
  }

  const lockPath = getLockPath(projectRoot, repo, prNumber);

  if (existsSync(lockPath)) {
    try {
      const data: LockData = JSON.parse(readFileSync(lockPath, "utf-8"));
      if (isProcessAlive(data.pid)) {
        return false; // lock is held by a live process
      }
      console.warn(`[lock] Removing stale lock for ${repo}#${prNumber} (PID ${data.pid} no longer running)`);
      unlinkSync(lockPath);
    } catch {
      // Corrupt or already deleted — attempt removal and proceed
      try { unlinkSync(lockPath); } catch { /* already gone */ }
    }
  }

  // Atomically create the lock file using O_EXCL (fails if another process just created it)
  const lockData: LockData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    reviewId,
  };
  const content = Buffer.from(JSON.stringify(lockData, null, 2), "utf-8");

  try {
    const fd = openSync(lockPath, "wx"); // wx = O_CREAT | O_EXCL | O_WRONLY
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return false; // another process won the race
    }
    throw err;
  }
}

/**
 * Release the lock for a PR. Safe to call even if the lock doesn't exist.
 */
export function releaseLock(
  projectRoot: string,
  repo: string,
  prNumber: number
): void {
  const lockPath = getLockPath(projectRoot, repo, prNumber);
  try {
    unlinkSync(lockPath);
  } catch { /* already gone — that's fine */ }
}

/**
 * Read the current lock data without acquiring or releasing it.
 * Returns null if no lock exists or the file is unreadable.
 */
export function getLockInfo(
  projectRoot: string,
  repo: string,
  prNumber: number
): LockData | null {
  const lockPath = getLockPath(projectRoot, repo, prNumber);
  try {
    return JSON.parse(readFileSync(lockPath, "utf-8")) as LockData;
  } catch {
    return null;
  }
}
