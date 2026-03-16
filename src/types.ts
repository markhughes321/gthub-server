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
  reviewedAt: string;
  reviewPath: string;
  status: "complete" | "failed";
}

export interface ReviewState {
  reviewed: Record<string, ReviewedEntry>;
}

export interface ReviewMeta {
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  headSha: string;
  reviewedAt: string;
  filesChanged: number;
  reviewModel: string;
}
