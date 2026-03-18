import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getProjectRoot } from "./config.js";
import type { ReviewState, ReviewedEntry } from "./types.js";

function getStatePath(): string {
  return join(getProjectRoot(), "state", "reviewed.json");
}

export function loadState(): ReviewState {
  const statePath = getStatePath();
  const stateDir = dirname(statePath);

  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  if (!existsSync(statePath)) {
    const empty: ReviewState = { reviewed: {} };
    writeFileSync(statePath, JSON.stringify(empty, null, 2));
    return empty;
  }

  try {
    return JSON.parse(readFileSync(statePath, "utf-8"));
  } catch (err) {
    const backupPath = `${statePath}.corrupt`;
    console.error(`[state] Corrupt state file — backing up to ${backupPath} and starting fresh. Error: ${err}`);
    renameSync(statePath, backupPath);
    const empty: ReviewState = { reviewed: {} };
    writeFileSync(statePath, JSON.stringify(empty, null, 2));
    return empty;
  }
}

export function saveState(state: ReviewState): void {
  const statePath = getStatePath();
  const tmpPath = `${statePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  renameSync(tmpPath, statePath);
}

export function needsReview(
  state: ReviewState,
  repo: string,
  prNumber: number,
  headSha: string
): boolean {
  const key = `${repo}#${prNumber}`;
  const entry = state.reviewed[key];
  if (!entry) return true;
  if (entry.headSha !== headSha) return true;
  return false;
}

export function markReviewed(
  state: ReviewState,
  repo: string,
  prNumber: number,
  entry: ReviewedEntry
): void {
  const key = `${repo}#${prNumber}`;
  const existing = state.reviewed[key];
  // Carry forward the previous SHA/path so diff-aware re-reviews can reference them
  if (existing?.headSha && existing.headSha !== entry.headSha && existing.status === "complete") {
    entry.previousHeadSha = existing.headSha;
    entry.previousReviewPath = existing.reviewPath;
  }
  state.reviewed[key] = entry;
}

export function hideReview(
  state: ReviewState,
  repo: string,
  prNumber: number
): boolean {
  const key = `${repo}#${prNumber}`;
  const entry = state.reviewed[key];
  if (!entry) return false;
  entry.hidden = true;
  saveState(state);
  return true;
}

export function getPreviousReview(
  state: ReviewState,
  repo: string,
  prNumber: number
): { headSha: string; reviewPath: string } | null {
  const key = `${repo}#${prNumber}`;
  const entry = state.reviewed[key];
  if (entry?.previousHeadSha && entry.previousReviewPath) {
    return { headSha: entry.previousHeadSha, reviewPath: entry.previousReviewPath };
  }
  if (entry?.headSha && entry.reviewPath && entry.status === "complete") {
    return { headSha: entry.headSha, reviewPath: entry.reviewPath };
  }
  return null;
}
