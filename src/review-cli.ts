/**
 * CLI for manually reviewing a single PR.
 * Usage:
 *   npm run review -- owner/repo 123
 *   npm run review -- owner/repo#123
 *   npm run review -- https://github.com/owner/repo/pull/123
 */
import { loadConfig } from "./config.js";
import { listOpenPRs } from "./github.js";
import { reviewPR } from "./reviewer.js";
import { execFile } from "child_process";
import { promisify } from "util";
import type { PullRequest } from "./types.js";

const execFileAsync = promisify(execFile);

interface PRTarget {
  repo: string;
  prNumber: number;
}

function parseTarget(args: string[]): PRTarget | null {
  // Form 1: single GitHub URL — https://github.com/owner/repo/pull/123
  if (args.length === 1) {
    const urlMatch = args[0].match(
      /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/
    );
    if (urlMatch) {
      return { repo: urlMatch[1], prNumber: parseInt(urlMatch[2], 10) };
    }

    // Form 2: owner/repo#123
    const shortMatch = args[0].match(/^([^#\s]+)#(\d+)$/);
    if (shortMatch) {
      return { repo: shortMatch[1], prNumber: parseInt(shortMatch[2], 10) };
    }

    return null;
  }

  // Form 3: owner/repo 123  (original two-arg form)
  if (args.length >= 2) {
    const prNumber = parseInt(args[1], 10);
    if (!isNaN(prNumber)) {
      return { repo: args[0], prNumber };
    }
  }

  return null;
}

async function fetchPR(repo: string, prNumber: number): Promise<PullRequest | null> {
  // Try open PRs first
  const prs = await listOpenPRs(repo);
  const found = prs.find((p) => p.number === prNumber);
  if (found) return found;

  // Fall back to gh pr view for closed/merged PRs
  try {
    const { stdout } = await execFileAsync("gh", [
      "pr", "view", String(prNumber), "--repo", repo,
      "--json", "number,title,headRefOid,isDraft,state,author,url,baseRefName,headRefName,additions,deletions,changedFiles",
    ]);
    return JSON.parse(stdout.trim()) as PullRequest;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = parseTarget(args);

  if (!target) {
    console.error(
      "Usage:\n" +
      "  npm run review -- owner/repo <pr-number>\n" +
      "  npm run review -- owner/repo#<pr-number>\n" +
      "  npm run review -- https://github.com/owner/repo/pull/<pr-number>"
    );
    process.exit(1);
  }

  const { repo, prNumber } = target;
  const config = loadConfig();

  console.log(`Fetching ${repo}#${prNumber}...`);
  const pr = await fetchPR(repo, prNumber);

  if (!pr) {
    console.error(`PR #${prNumber} not found in ${repo}.`);
    process.exit(1);
  }

  console.log(`Reviewing: ${pr.title} by ${pr.author.login} [${pr.state}]`);
  const result = await reviewPR(config, pr, repo);

  if (result) {
    console.log(`\nReview complete: ${result}`);
  } else {
    console.error("\nReview failed.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
