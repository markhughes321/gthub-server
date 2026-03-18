import { execSync } from "child_process";
import type { ChildProcess } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, basename, dirname } from "path";
import type { PRType } from "./pr-classifier.js";
import type { TokenUsage } from "./types.js";
import type { SeveritySummary } from "./severity.js";

export interface ReviewInfo {
  id: string;
  repo: string;
  prNumber: number;
  title: string;
  author: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  baseRefName: string;
  headRefName: string;
  url: string;
  headSha: string;
  completedAt?: string;
  skill: string;
  prType: PRType;
  model: string;
  startedAt: string;
  reviewPath: string;
  status: "running" | "complete" | "failed" | "killed";
  tokenUsage?: TokenUsage;
  severitySummary?: SeveritySummary;
}

interface ManagedReview extends ReviewInfo {
  chunks: string[];
  proc?: ChildProcess;
  subscribers: Set<(chunk: string) => void>;
  doneCallbacks: Set<(status: string) => void>;
}

const reviews = new Map<string, ManagedReview>();
const MAX_REVIEWS = 100;

function pruneOldReviews(): void {
  if (reviews.size <= MAX_REVIEWS) return;
  const completed = Array.from(reviews.values())
    .filter((r) => r.status !== "running")
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
  const toRemove = reviews.size - MAX_REVIEWS;
  for (let i = 0; i < toRemove && i < completed.length; i++) {
    reviews.delete(completed[i].id);
  }
}

export function registerReview(info: ReviewInfo, proc: ChildProcess): void {
  reviews.set(info.id, {
    ...info,
    chunks: [],
    proc,
    subscribers: new Set(),
    doneCallbacks: new Set(),
  });
  pruneOldReviews();
}

// updateProc removed — registerReview now always receives the real proc

export function appendChunk(id: string, chunk: string): void {
  const review = reviews.get(id);
  if (!review) return;
  review.chunks.push(chunk);
  for (const sub of review.subscribers) {
    try { sub(chunk); } catch { /* subscriber gone */ }
  }
}

export function setTokenUsage(id: string, usage: TokenUsage): void {
  const review = reviews.get(id);
  if (review) review.tokenUsage = usage;
}

export function setSeverity(id: string, severity: SeveritySummary): void {
  const review = reviews.get(id);
  if (review) review.severitySummary = severity;
}

export function finishReview(
  id: string,
  status: "complete" | "failed" | "killed"
): void {
  const review = reviews.get(id);
  if (!review || review.status !== "running") return; // already handled
  review.status = status;
  review.completedAt = new Date().toISOString();
  review.proc = undefined;
  for (const cb of review.doneCallbacks) {
    try { cb(status); } catch { /* subscriber gone */ }
  }
  review.subscribers.clear();
  review.doneCallbacks.clear();
}

export function killReview(id: string): boolean {
  const review = reviews.get(id);
  if (!review || review.status !== "running" || !review.proc) return false;

  // Mark killed before killing the proc so the close-event handler sees it
  review.status = "killed";
  review.completedAt = new Date().toISOString();
  const pid = review.proc.pid;

  if (pid !== undefined) {
    if (process.platform === "win32") {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
    } else {
      try { process.kill(-pid, "SIGTERM"); } catch { review.proc!.kill("SIGTERM"); }
    }
  }

  // Notify SSE subscribers
  for (const cb of review.doneCallbacks) {
    try { cb("killed"); } catch { /* gone */ }
  }
  review.proc = undefined;
  review.subscribers.clear();
  review.doneCallbacks.clear();
  return true;
}

export function subscribe(
  id: string,
  onChunk: (chunk: string) => void,
  onDone: (status: string) => void
): (() => void) | null {
  const review = reviews.get(id);
  if (!review) return null;
  review.subscribers.add(onChunk);
  review.doneCallbacks.add(onDone);
  return () => {
    review.subscribers.delete(onChunk);
    review.doneCallbacks.delete(onDone);
  };
}

export function getAll(): ReviewInfo[] {
  return Array.from(reviews.values())
    .map(({ chunks, proc, subscribers, doneCallbacks, ...info }) => info)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

export function get(id: string): { info: ReviewInfo; chunks: string[] } | null {
  const review = reviews.get(id);
  if (!review) return null;
  const { proc, subscribers, doneCallbacks, chunks, ...info } = review;
  return { info, chunks: [...chunks] };
}

/**
 * Called on startup. Reads state/reviewed.json and per-PR meta.json files to
 * restore completed reviews so they appear in the dashboard after a restart.
 */
export function loadHistoricalReviews(projectRoot: string): void {
  const statePath = join(projectRoot, "state", "reviewed.json");
  if (!existsSync(statePath)) return;

  let state: {
    reviewed: Record<
      string,
      { title: string; reviewedAt: string; reviewPath: string; status: string }
    >;
  };

  try {
    state = JSON.parse(readFileSync(statePath, "utf-8"));
  } catch {
    return;
  }

  for (const [key, entry] of Object.entries(state.reviewed)) {
    if (!entry.reviewPath) continue;

    // key format: "owner/repo#prNumber"
    const hashIdx = key.lastIndexOf("#");
    if (hashIdx === -1) continue;
    const repo = key.slice(0, hashIdx);
    const prNumber = parseInt(key.slice(hashIdx + 1), 10);
    if (isNaN(prNumber)) continue;

    // Derive id from filename; meta.json may supply a stored id to use instead
    const filename = basename(entry.reviewPath, ".md"); // "review-2026-03-17T21-37-05"
    const ts = filename.replace(/^review-/, "");
    const safeRepo = repo.replace(/\//g, "-");
    const derivedId = `${safeRepo}-PR${prNumber}-${ts}`;

    const metaPath = join(projectRoot, dirname(entry.reviewPath), "meta.json");
    let id = derivedId;
    let skill = "pr-review";
    let model = "unknown";
    let prType: PRType = "MIXED";
    let author = "";
    let isDraft = false;
    let additions = 0;
    let deletions = 0;
    let changedFiles = 0;
    let baseRefName = "";
    let headRefName = "";
    let url = "";
    let headSha = "";
    let completedAt: string | undefined = undefined;
    let tokenUsage: TokenUsage | undefined = undefined;
    let severitySummary: SeveritySummary | undefined = undefined;

    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        id = meta.id ?? id;
        skill = meta.reviewSkill ?? skill;
        model = meta.reviewModel ?? model;
        prType = meta.prType ?? prType;
        author = meta.author ?? author;
        isDraft = meta.isDraft ?? isDraft;
        additions = meta.additions ?? additions;
        deletions = meta.deletions ?? deletions;
        changedFiles = meta.filesChanged ?? changedFiles;
        baseRefName = meta.baseRefName ?? baseRefName;
        headRefName = meta.headRefName ?? headRefName;
        url = meta.url ?? url;
        headSha = meta.headSha ?? headSha;
        completedAt = meta.reviewedAt ?? completedAt;
        tokenUsage = meta.tokenUsage ?? tokenUsage;
        severitySummary = meta.severitySummary ?? severitySummary;
      } catch (err) {
        console.warn(`[history] Could not parse meta.json for ${key}: ${err} — using defaults`);
      }
    }

    if (reviews.has(id)) continue; // already registered this session

    const status =
      entry.status === "complete" || entry.status === "failed" || entry.status === "killed"
        ? entry.status
        : "complete";

    reviews.set(id, {
      id,
      repo,
      prNumber,
      title: entry.title,
      author,
      isDraft,
      additions,
      deletions,
      changedFiles,
      baseRefName,
      headRefName,
      url,
      headSha,
      completedAt,
      skill,
      prType,
      model,
      startedAt: entry.reviewedAt,
      reviewPath: entry.reviewPath,
      status,
      tokenUsage,
      severitySummary,
      chunks: [],
      subscribers: new Set(),
      doneCallbacks: new Set(),
    });
  }
}
