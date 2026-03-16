import { execFile } from "child_process";
import { promisify } from "util";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "fs";
import { join } from "path";
import { getPRView, getPRDiff } from "./github.js";
import { loadState, saveState, markReviewed } from "./state.js";
import { notify } from "./notifier.js";
import { getProjectRoot, type Config } from "./config.js";
import type { PullRequest, ReviewMeta } from "./types.js";

const execFileAsync = promisify(execFile);

function safeRepoName(repo: string): string {
  return repo.replace(/\//g, "-");
}

function timestamp(): string {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function buildPrompt(
  promptTemplate: string,
  repo: string,
  prNumber: number,
  prView: string,
  prDiff: string,
  confidenceThreshold: number
): string {
  const filled = promptTemplate
    .replace(/\{\{REPO\}\}/g, repo)
    .replace(/\{\{PR_NUMBER\}\}/g, String(prNumber))
    .replace(/\{\{CONFIDENCE_THRESHOLD\}\}/g, String(confidenceThreshold))
    .replace(/\{\{TIMESTAMP\}\}/g, new Date().toISOString());

  return `${filled}

## Pull Request: ${repo}#${prNumber}

### PR Metadata
${prView}

### Diff
\`\`\`diff
${prDiff}
\`\`\``;
}

export async function reviewPR(
  config: Config,
  pr: PullRequest,
  repo: string
): Promise<string | null> {
  const projectRoot = getProjectRoot();
  const reviewDir = join(
    projectRoot,
    "reviews",
    safeRepoName(repo),
    `PR-${pr.number}`
  );

  if (!existsSync(reviewDir)) {
    mkdirSync(reviewDir, { recursive: true });
  }

  const ts = timestamp();
  const reviewPath = join(reviewDir, `review-${ts}.md`);
  const metaPath = join(reviewDir, "meta.json");

  try {
    const [prView, prDiff] = await Promise.all([
      getPRView(repo, pr.number),
      getPRDiff(repo, pr.number),
    ]);

    const promptTemplate = readFileSync(
      join(projectRoot, "prompts", "review-prompt.md"),
      "utf-8"
    );

    const fullPrompt = buildPrompt(
      promptTemplate,
      repo,
      pr.number,
      prView,
      prDiff,
      config.confidenceThreshold
    );

    const { stdout: reviewOutput } = await execFileAsync(
      "claude",
      [
        "-p",
        fullPrompt,
        "--model",
        config.reviewModel,
        "--output-format",
        "text",
        "--max-turns",
        "1",
      ],
      {
        maxBuffer: 50 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
      }
    );

    writeFileSync(reviewPath, reviewOutput.trim());

    const meta: ReviewMeta = {
      repo,
      number: pr.number,
      title: pr.title,
      author: pr.author.login,
      url: pr.url,
      headSha: pr.headRefOid,
      reviewedAt: new Date().toISOString(),
      filesChanged: pr.changedFiles,
      reviewModel: config.reviewModel,
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const state = loadState();
    markReviewed(state, repo, pr.number, {
      headSha: pr.headRefOid,
      reviewedAt: new Date().toISOString(),
      reviewPath: `reviews/${safeRepoName(repo)}/PR-${pr.number}/review-${ts}.md`,
      status: "complete",
    });
    saveState(state);

    if (config.notify) {
      notify(
        `Review Ready: ${repo}#${pr.number}`,
        `${pr.title} by ${pr.author.login}`
      );
    }

    console.log(`Review saved: ${reviewPath}`);
    return reviewPath;
  } catch (error) {
    const errMsg =
      error instanceof Error ? error.message : String(error);
    console.error(`Failed to review ${repo}#${pr.number}: ${errMsg}`);

    const state = loadState();
    markReviewed(state, repo, pr.number, {
      headSha: pr.headRefOid,
      reviewedAt: new Date().toISOString(),
      reviewPath: "",
      status: "failed",
    });
    saveState(state);

    if (config.notify) {
      notify(
        `Review Failed: ${repo}#${pr.number}`,
        errMsg.slice(0, 100)
      );
    }

    return null;
  }
}
