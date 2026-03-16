import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
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

  return JSON.parse(readFileSync(statePath, "utf-8"));
}

export function saveState(state: ReviewState): void {
  const statePath = getStatePath();
  writeFileSync(statePath, JSON.stringify(state, null, 2));
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
  state.reviewed[key] = entry;
}
