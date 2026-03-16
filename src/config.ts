import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export interface Config {
  repos: string[];
  pollIntervalSeconds: number;
  reviewModel: string;
  maxBudgetUsd: number;
  confidenceThreshold: number;
  postCommentToPr: boolean;
  notify: boolean;
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
    reviewModel: "sonnet",
    maxBudgetUsd: 0.5,
    confidenceThreshold: 80,
    postCommentToPr: false,
    notify: true,
  };

  return { ...defaults, ...config } as Config;
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}
