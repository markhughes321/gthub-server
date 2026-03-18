import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export interface Config {
  repos: string[];
  repoLocalPaths?: Record<string, string>;
  pollIntervalSeconds: number;
  reviewModel: string;
  notify: boolean;
  teamReviewThreshold: number;
  reviewTimeoutMinutes: number;
  parallelReviews: boolean;
  maxConcurrentReviews: number;
  port: number;
  /** Map PR type → skill name. Overrides size-based skill selection. */
  skillMap?: Partial<Record<import("./pr-classifier.js").PRType, string>>;
  /** Per-repo overrides: repoSkillMap["owner/repo"]["API"] = "custom-skill" */
  repoSkillMap?: Record<string, Partial<Record<import("./pr-classifier.js").PRType, string>>>;
  webhookSecret?: string;
  webhookPath?: string;
  /** When true, pass the previous review + incremental diff to Claude on re-reviews. Default: true. */
  diffAwareReviews?: boolean;
  /** Token pricing (USD per million tokens). Defaults to claude-opus-4-6 rates. */
  pricing?: {
    inputPerMTokens: number;
    outputPerMTokens: number;
    cacheReadPerMTokens: number;
    cacheCreationPerMTokens: number;
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

export function loadConfig(): Config {
  const configPath = join(PROJECT_ROOT, "config.json");
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as Partial<Config>;

  if (!config.repos || config.repos.length === 0) {
    throw new Error(
      'No repos configured. Edit config.json and add repos to the "repos" array.'
    );
  }

  const defaults: Config = {
    repos: [],
    pollIntervalSeconds: 300,
    reviewModel: "claude-opus-4-6",
    notify: true,
    teamReviewThreshold: 10,
    reviewTimeoutMinutes: 15,
    parallelReviews: false,
    maxConcurrentReviews: 3,
    port: 3000,
  };

  return { ...defaults, ...config } as Config;
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}
