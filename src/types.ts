export type { PRType } from "./pr-classifier.js";

export interface PullRequest {
  number: number;
  title: string;
  headRefOid: string;
  isDraft: boolean;
  state: string;
  author: { login: string };
  url: string;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface ReviewedEntry {
  headSha: string;
  title: string;
  reviewedAt: string;
  reviewPath: string;
  status: "complete" | "failed" | "killed";
  previousHeadSha?: string;
  previousReviewPath?: string;
}

export interface ReviewState {
  reviewed: Record<string, ReviewedEntry>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
}

export interface ReviewMeta {
  id: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  headSha: string;
  reviewedAt: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  filesChanged: number;
  baseRefName: string;
  headRefName: string;
  reviewModel: string;
  reviewSkill: string;
  prType: import("./pr-classifier.js").PRType;
  changedFileList: string[];
  tokenUsage?: TokenUsage;
  severitySummary?: import("./severity.js").SeveritySummary;
}
