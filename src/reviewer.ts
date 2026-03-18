import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { writeFileSync, mkdirSync, existsSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { loadState, saveState, markReviewed, getPreviousReview } from "./state.js";
import { notify } from "./notifier.js";
import { getProjectRoot, type Config } from "./config.js";
import type { PullRequest, ReviewMeta } from "./types.js";
import * as manager from "./review-manager.js";
import { getPRFileList } from "./github.js";
import { classifyPR, type PRType } from "./pr-classifier.js";
import { createWorktree, type WorktreeHandle } from "./worktree.js";
import { acquireLock, releaseLock } from "./lock.js";
import { parseSeverity } from "./severity.js";

interface ClaudeRun {
  proc: ChildProcess;
  result: Promise<{ text: string; rawUsage?: RawTokenUsage }>;
}

// Patterns that must never appear in activity logs or the dashboard.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/github_pat_[A-Za-z0-9_]+/g, "[REDACTED]"],
  [/ghp_[A-Za-z0-9]+/g, "[REDACTED]"],
  [/ghs_[A-Za-z0-9]+/g, "[REDACTED]"],
  [/GH_TOKEN=\S+/g, "GH_TOKEN=[REDACTED]"],
  [/GITHUB_PAT=\S+/g, "GITHUB_PAT=[REDACTED]"],
  [/GITHUB_TOKEN=\S+/g, "GITHUB_TOKEN=[REDACTED]"],
];

// @internal — exported for unit tests only
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

interface RawTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Parse a single line of --output-format stream-json output.
 * Returns { display, fileText, rawUsage } where display is shown in the dashboard
 * (includes tool call info) and fileText is clean prose for the saved file.
 */
// @internal — exported for unit tests only
export function parseStreamJsonLine(line: string): { display: string; fileText: string; rawUsage?: RawTokenUsage } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const event = JSON.parse(line) as any;

    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      const displayParts: string[] = [];

      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          displayParts.push(block.text);
        } else if (block.type === "tool_use" && block.name) {
          const cmd =
            typeof block.input?.command === "string"
              ? block.input.command
              : typeof block.input?.path === "string"
              ? block.input.path
              : JSON.stringify(block.input ?? {}).slice(0, 120);
          displayParts.push(`\n\u25b6 ${block.name}: ${cmd}\n`);
        }
      }

      return { display: redactSecrets(displayParts.join("")), fileText: "" };
    }

    // The result event carries the final accumulated text — use this exclusively
    // for the saved .md so intermediate thinking steps are excluded from Review tab.
    if (event.type === "result" && typeof event.result === "string") {
      return { display: "", fileText: redactSecrets(event.result), rawUsage: event.usage ?? undefined };
    }

    // Capture tool results so the activity log shows what each tool returned
    if (event.type === "user" && Array.isArray(event.message?.content)) {
      const parts: string[] = [];
      for (const block of event.message.content) {
        if (block.type !== "tool_result") continue;
        const content = block.content;
        let text = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter((c: { type: string; text?: string }) => c.type === "text" && c.text)
            .map((c: { type: string; text?: string }) => c.text as string)
            .join("");
        }
        if (text.trim()) {
          const truncated = text.length > 600 ? text.slice(0, 600) + " …" : text;
          parts.push(`  ↳ ${truncated.trim()}`);
        }
      }
      if (parts.length) {
        return { display: redactSecrets(parts.join("\n") + "\n"), fileText: "" };
      }
    }

    // Ignore all other event types (system, etc.)
    return { display: "", fileText: "" };
  } catch {
    // Not valid JSON — shouldn't happen with stream-json, but be safe
    return { display: "", fileText: "" };
  }
}

function runClaude(
  prompt: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  extraEnv: Record<string, string> | undefined,
  onDisplay?: (chunk: string) => void
): ClaudeRun {
  // Pass --print without inline text and write prompt to stdin to avoid
  // shell quoting issues on Windows where args with spaces get truncated.
  const proc = spawn("claude", ["--print", ...args], {
    shell: true,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    env: { ...process.env, ...extraEnv },
  });

  const fileChunks: string[] = [];
  const errChunks: Buffer[] = [];
  let lineBuffer = "";
  let capturedUsage: RawTokenUsage | undefined;

  proc.stdout.on("data", (d: Buffer) => {
    lineBuffer += d.toString();
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? ""; // keep incomplete trailing line

    for (const line of lines) {
      if (!line.trim()) continue;
      const { display, fileText, rawUsage } = parseStreamJsonLine(line);
      if (display) onDisplay?.(display);
      if (fileText) fileChunks.push(fileText);
      if (rawUsage) capturedUsage = rawUsage;
    }
  });

  proc.stderr.on("data", (d: Buffer) => errChunks.push(d));

  const result = new Promise<{ text: string; rawUsage?: RawTokenUsage }>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      // Flush any remaining buffered line
      if (lineBuffer.trim()) {
        const { display, fileText, rawUsage } = parseStreamJsonLine(lineBuffer);
        if (display) onDisplay?.(display);
        if (fileText) fileChunks.push(fileText);
        if (rawUsage) capturedUsage = rawUsage;
      }

      if (code !== 0 && code !== null) {
        const stderr = Buffer.concat(errChunks).toString();
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
      } else {
        resolve({ text: fileChunks.join(""), rawUsage: capturedUsage });
      }
    });
  });

  proc.stdin.write(prompt);
  proc.stdin.end();

  return { proc, result };
}

function selectSkill(
  changedFiles: number,
  threshold: number,
  prType: PRType,
  repo: string,
  config: Config
): string {
  // Per-repo override takes highest priority
  const repoMap = config.repoSkillMap?.[repo];
  if (repoMap?.[prType]) return repoMap[prType]!;

  // Global skillMap override
  if (config.skillMap?.[prType]) return config.skillMap[prType]!;

  // Default: size-based selection
  return changedFiles >= threshold ? "pr-review-team" : "pr-review";
}

function buildPrompt(
  skill: string,
  repo: string,
  pr: PullRequest,
  prType: PRType,
  fileList: string[]
): string {
  const fileListText = fileList.length > 0
    ? fileList.map((f) => `- ${f}`).join("\n")
    : "(file list unavailable — use gh pr diff --name-only to fetch)";

  return [
    `## Working directory`,
    `Your current working directory is already the repository checked out at the PR's exact commit.`,
    `Do NOT cd to any other path. Do NOT use the "Known Local Repos" path listed in the skill —`,
    `you are already there (in an isolated worktree at the right commit).`,
    ``,
    `## Pre-completed Step 1 tasks — do NOT repeat any of these`,
    `- Step 1.1: PR metadata pre-fetched below — do NOT run "gh pr view"`,
    `- Step 1.2: Changed file list pre-fetched below — do NOT run "gh pr diff --name-only"`,
    `- Step 1.3: Already at the repo directory (current working directory)`,
    `- Step 1.4: Already checked out to the PR's exact commit (detached HEAD).`,
    `  Do NOT run git fetch, git stash, git checkout, or git stash pop.`,
    `- Step 1.5: PR type pre-classified below`,
    `- Step 6 (cleanup): Handled automatically — do NOT remove the worktree`,
    ``,
    `Start at Step 2 (spawn agents + read files).`,
    ``,
    `Read .claude/skills/${skill}/skill.md and follow its review process for ${repo}#${pr.number}.`,
    ``,
    `## Pre-fetched PR metadata (Step 1.1)`,
    `Title: ${pr.title}`,
    `Author: ${pr.author.login}`,
    `Branch: ${pr.headRefName} → ${pr.baseRefName}`,
    `State: ${pr.state}${pr.isDraft ? " (draft)" : ""}`,
    `Files changed: ${pr.changedFiles} (+${pr.additions} / -${pr.deletions})`,
    `URL: ${pr.url}`,
    ``,
    `## Pre-classified PR type (Step 1.5)`,
    prType,
    ``,
    `## Changed files — authoritative list from gh pr diff --name-only (Step 1.2)`,
    fileListText,
  ].join("\n");
}

function buildIncrementalPrompt(
  skill: string,
  repo: string,
  pr: PullRequest,
  prType: PRType,
  fileList: string[],
  previousReviewText: string,
  diffSinceLastReview: string,
  previousSha: string
): string {
  const fileListText = fileList.length > 0
    ? fileList.map((f) => `- ${f}`).join("\n")
    : "(file list unavailable)";

  const diffText = diffSinceLastReview.trim().length > 0
    ? diffSinceLastReview.slice(0, 40_000) // cap very large diffs
    : "(no diff — the PR's own files are unchanged since the last review)";

  return [
    `## Working directory`,
    `Your current working directory is already the repository checked out at the PR's exact commit.`,
    `Do NOT cd to any other path. Do NOT use the "Known Local Repos" path listed in the skill —`,
    `you are already there (in an isolated worktree at the right commit).`,
    ``,
    `## Pre-completed Step 1 tasks — do NOT repeat any of these`,
    `- Step 1.1: PR metadata pre-fetched below — do NOT run "gh pr view"`,
    `- Step 1.2: Changed file list pre-fetched below — do NOT run "gh pr diff --name-only"`,
    `- Step 1.3: Already at the repo directory (current working directory)`,
    `- Step 1.4: Already checked out to the PR's exact commit (detached HEAD).`,
    `  Do NOT run git fetch, git stash, git checkout, or git stash pop.`,
    `- Step 1.5: PR type pre-classified below`,
    `- Step 6 (cleanup): Handled automatically — do NOT remove the worktree`,
    ``,
    `## RE-REVIEW MODE — This PR was previously reviewed. New commits have been pushed.`,
    ``,
    `Start at Step 2. Read .claude/skills/${skill}/skill.md and follow its review process for ${repo}#${pr.number}.`,
    `Run the complete skill — do not skip any steps (gates, file reads, API probing).`,
    `The previous review is provided as reference context only: use it to note which`,
    `prior findings have been addressed and which remain open. Do not let it limit the`,
    `scope of your analysis — new issues not in the previous review must still be reported.`,
    ``,
    `## Pre-fetched PR metadata (Step 1.1)`,
    `Title: ${pr.title}`,
    `Author: ${pr.author.login}`,
    `Branch: ${pr.headRefName} → ${pr.baseRefName}`,
    `State: ${pr.state}${pr.isDraft ? " (draft)" : ""}`,
    `Files changed: ${pr.changedFiles} (+${pr.additions} / -${pr.deletions})`,
    `URL: ${pr.url}`,
    ``,
    `## Pre-classified PR type (Step 1.5)`,
    prType,
    ``,
    `## Changed files (full PR)`,
    fileListText,
    ``,
    `## Previous review (SHA ${previousSha.slice(0, 7)})`,
    `<previous_review>`,
    previousReviewText.slice(0, 20_000),
    `</previous_review>`,
    ``,
    `## Diff since last review (${previousSha.slice(0, 7)} → ${pr.headRefOid.slice(0, 7)})`,
    `<diff>`,
    diffText,
    `</diff>`,
  ].join("\n");
}

function extractSummary(output: string): string {
  for (const line of output.split("\n")) {
    const stripped = line.trim();
    if (!stripped || stripped.match(/^[-=*_]{3,}$/)) continue;
    const text = stripped.replace(/^#+\s+/, "");
    if (text.length > 10) return text.slice(0, 100);
  }
  return "";
}

function safeRepoName(repo: string): string {
  return repo.replace(/\//g, "-");
}

function timestamp(): string {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function loadGHToken(localRepoPath: string): string | undefined {
  const envPath = join(localRepoPath, ".env.local");
  try {
    const content = readFileSync(envPath, "utf-8");
    const match = content.match(/^GITHUB_PAT\s*=\s*(.+)$/m);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export async function reviewPR(
  config: Config,
  pr: PullRequest,
  repo: string,
  skillOverride?: string
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
  const logPath = join(reviewDir, `review-${ts}.log`);
  const metaPath = join(reviewDir, "meta.json");
  const timeoutMs = config.reviewTimeoutMinutes * 60 * 1000;
  const localPath = config.repoLocalPaths?.[repo];
  const reviewId = `${safeRepoName(repo)}-PR${pr.number}-${ts}`;

  // Acquire per-PR lock to prevent concurrent reviews of the same PR across processes
  if (!acquireLock(projectRoot, repo, pr.number, reviewId)) {
    console.log(`  Skip ${repo}#${pr.number} — already being reviewed by another process`);
    return null;
  }
  let lockAcquired = true;

  // Fetch authoritative file list and classify PR type
  let prFileList: string[] = [];
  let prType: PRType = "MIXED"; // safe fallback — triggers full review if fetch fails
  try {
    prFileList = await getPRFileList(repo, pr.number);
    prType = classifyPR(prFileList);
    console.log(`  PR type: ${prType} (${prFileList.length} files)`);
  } catch (err) {
    console.warn(`  Could not fetch file list for ${repo}#${pr.number}: ${err} — falling back to MIXED`);
  }

  const skill = skillOverride ?? selectSkill(pr.changedFiles, config.teamReviewThreshold, prType, repo, config);

  // Create isolated git worktree so the main repo is never touched
  let worktreeHandle: WorktreeHandle | undefined;
  let reviewCwd: string | undefined;
  if (localPath) {
    worktreeHandle = await createWorktree(
      localPath,
      pr.number,
      pr.headRefOid,
      pr.headRefName,
      projectRoot
    );
    reviewCwd = worktreeHandle.path;
  }

  // Build prompt — use incremental mode when a previous review exists and worktree is available
  let prompt: string;
  const diffAware = config.diffAwareReviews !== false;
  const prevReview = diffAware ? getPreviousReview(loadState(), repo, pr.number) : null;

  if (prevReview && reviewCwd) {
    let previousReviewText = "";
    let diffSinceLastReview = "";
    try {
      const prevReviewAbs = join(projectRoot, prevReview.reviewPath);
      previousReviewText = existsSync(prevReviewAbs)
        ? readFileSync(prevReviewAbs, "utf-8")
        : "";
    } catch { /* fall through to full review */ }
    try {
      const { execFileSync: execSync2 } = await import("child_process");
      diffSinceLastReview = execSync2(
        "git", ["diff", prevReview.headSha, pr.headRefOid, "--"],
        { cwd: reviewCwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
      );
    } catch { /* fall through to full review */ }

    // Only use incremental mode when the diff actually touches the PR's own files.
    // A diff that only contains changes from other merged PRs (e.g. a merge-develop commit)
    // provides no new signal about this PR — fall back to a full review so the skill
    // runs completely rather than short-circuiting on a "trivial" diff.
    const diffTouchesPRFiles = prFileList.length > 0 && prFileList.some(f => diffSinceLastReview.includes(f));

    if (previousReviewText && diffTouchesPRFiles) {
      console.log(`  Diff-aware re-review: ${prevReview.headSha.slice(0, 7)} → ${pr.headRefOid.slice(0, 7)}`);
      prompt = buildIncrementalPrompt(
        skill, repo, pr, prType, prFileList,
        previousReviewText, diffSinceLastReview, prevReview.headSha
      );
    } else {
      if (previousReviewText && !diffTouchesPRFiles) {
        console.log(`  Re-review: diff contains no PR-file changes (merge-only commit) — running full review`);
      }
      prompt = buildPrompt(skill, repo, pr, prType, prFileList);
    }
  } else {
    prompt = buildPrompt(skill, repo, pr, prType, prFileList);
  }

  const ghToken = localPath ? loadGHToken(localPath) : undefined;
  const extraEnv: Record<string, string> = {};
  if (ghToken) extraEnv["GH_TOKEN"] = ghToken;

  let logBuffer = "";
  const flushLog = (): void => {
    if (logBuffer) {
      appendFileSync(logPath, logBuffer);
      logBuffer = "";
    }
  };
  const logFlushTimer = setInterval(flushLog, 50);

  const { proc, result } = runClaude(
    prompt,
    [
      "--model",
      config.reviewModel,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "50",
      "--allowedTools",
      "Skill,Read,Write,Glob,Grep,Agent,WebFetch,TodoWrite,Bash(git:*),Bash(gh:*),Bash(npm:*),Bash(node:*),Bash(npx:*),Bash(cat:*),Bash(grep:*),Bash(tail:*)",
    ],
    reviewCwd,
    timeoutMs,
    extraEnv,
    (display) => {
      manager.appendChunk(reviewId, display);
      logBuffer += display;
      if (logBuffer.length >= 4096) flushLog();
    }
  );

  manager.registerReview(
    {
      id: reviewId,
      repo,
      prNumber: pr.number,
      title: pr.title,
      author: pr.author.login,
      isDraft: pr.isDraft,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      url: pr.url,
      headSha: pr.headRefOid,
      skill,
      prType,
      model: config.reviewModel,
      startedAt: new Date().toISOString(),
      reviewPath: `reviews/${safeRepoName(repo)}/PR-${pr.number}/review-${ts}.md`,
      status: "running",
    },
    proc
  );

  try {
    const { text: reviewOutput, rawUsage } = await result;

    writeFileSync(reviewPath, reviewOutput.trim());
    manager.finishReview(reviewId, "complete");

    // Compute cost from token usage
    const pricing = config.pricing ?? {
      inputPerMTokens: 15,
      outputPerMTokens: 75,
      cacheReadPerMTokens: 1.5,
      cacheCreationPerMTokens: 18.75,
    };
    const tokenUsage = rawUsage ? {
      inputTokens: rawUsage.input_tokens ?? 0,
      outputTokens: rawUsage.output_tokens ?? 0,
      cacheReadTokens: rawUsage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: rawUsage.cache_creation_input_tokens ?? 0,
      estimatedCostUsd: (
        ((rawUsage.input_tokens ?? 0) * pricing.inputPerMTokens +
         (rawUsage.output_tokens ?? 0) * pricing.outputPerMTokens +
         (rawUsage.cache_read_input_tokens ?? 0) * pricing.cacheReadPerMTokens +
         (rawUsage.cache_creation_input_tokens ?? 0) * pricing.cacheCreationPerMTokens) / 1_000_000
      ),
    } : undefined;

    const meta: ReviewMeta = {
      id: reviewId,
      repo,
      number: pr.number,
      title: pr.title,
      author: pr.author.login,
      url: pr.url,
      headSha: pr.headRefOid,
      reviewedAt: new Date().toISOString(),
      isDraft: pr.isDraft,
      additions: pr.additions,
      deletions: pr.deletions,
      filesChanged: pr.changedFiles,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      reviewModel: config.reviewModel,
      reviewSkill: skill,
      prType,
      changedFileList: prFileList,
      tokenUsage,
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    // Parse severity and register in the live review manager
    const severitySummary = parseSeverity(reviewOutput);
    meta.severitySummary = severitySummary;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    if (tokenUsage) manager.setTokenUsage(reviewId, tokenUsage);
    manager.setSeverity(reviewId, severitySummary);

    const state = loadState();
    markReviewed(state, repo, pr.number, {
      headSha: pr.headRefOid,
      title: pr.title,
      reviewedAt: new Date().toISOString(),
      reviewPath: `reviews/${safeRepoName(repo)}/PR-${pr.number}/review-${ts}.md`,
      status: "complete",
    });
    saveState(state);

    if (config.notify) {
      const rawSummary = extractSummary(reviewOutput);
      // Strip "PR Review: #NNN — " prefix that the review output often starts with,
      // since the notification title already contains the repo and PR number.
      const summary = rawSummary.replace(/^PR Review[:\s]+#\d+\s*[—–-]+\s*/i, "");
      const body = summary
        ? `${pr.author.login} · ${summary}`
        : `${pr.title} by ${pr.author.login}`;
      notify(`${repo}#${pr.number} — Review Ready`, body, pr.url);
    }

    console.log(`Review saved (${skill}): ${reviewPath}`);
    return reviewPath;
  } catch (error) {
    const isKilled = manager.get(reviewId)?.info.status === "killed";
    manager.finishReview(reviewId, isKilled ? "killed" : "failed");

    if (!isKilled) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to review ${repo}#${pr.number}: ${errMsg}`);

      const state = loadState();
      markReviewed(state, repo, pr.number, {
        headSha: pr.headRefOid,
        title: pr.title,
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
    }

    return null;
  } finally {
    clearInterval(logFlushTimer);
    flushLog();
    await worktreeHandle?.cleanup();
    if (lockAcquired) releaseLock(projectRoot, repo, pr.number);
  }
}
