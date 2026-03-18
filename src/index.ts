import { execFileSync } from "child_process";
import { loadConfig, getProjectRoot } from "./config.js";
import { listOpenPRs } from "./github.js";
import { loadState, needsReview } from "./state.js";
import { reviewPR } from "./reviewer.js";
import { startServer } from "./server.js";
import { loadHistoricalReviews } from "./review-manager.js";
import { cleanupOrphanedWorktrees } from "./worktree.js";
import { configureQueue, getQueue } from "./queue.js";

async function poll(): Promise<void> {
  const config = loadConfig();
  const state = loadState();
  const queue = getQueue();

  console.log(
    `[${new Date().toISOString()}] Polling ${config.repos.length} repo(s)... (queue: ${queue.active} active, ${queue.pending} pending)`
  );

  for (const repo of config.repos) {
    try {
      const prs = await listOpenPRs(repo);
      console.log(
        `  ${repo}: ${prs.length} open non-draft PR(s)`
      );

      const prsToReview = prs.filter((pr) => {
        if (!needsReview(state, repo, pr.number, pr.headRefOid)) {
          console.log(
            `  Skip ${repo}#${pr.number} (already reviewed at ${pr.headRefOid.slice(0, 7)})`
          );
          return false;
        }
        console.log(`  Queuing ${repo}#${pr.number}: ${pr.title}`);
        return true;
      });

      for (const pr of prsToReview) {
        queue.enqueue(() => reviewPR(config, pr, repo).then(() => {}));
      }
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      console.error(`  Error polling ${repo}: ${errMsg}`);
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const intervalMs = config.pollIntervalSeconds * 1000;

  configureQueue(config.maxConcurrentReviews);

  await cleanupOrphanedWorktrees(getProjectRoot(), config.repoLocalPaths ?? {});
  loadHistoricalReviews(getProjectRoot());
  startServer(config.port);

  console.log("revue started");
  console.log(`  Repos: ${config.repos.join(", ")}`);
  console.log(`  Poll interval: ${config.pollIntervalSeconds}s`);
  console.log(`  Model: ${config.reviewModel}`);
  console.log(`  Max concurrent reviews: ${config.maxConcurrentReviews}`);
  console.log("");

  // Run immediately on start
  await poll();

  // Then poll on interval
  const interval = setInterval(() => {
    poll().catch((err) => {
      console.error(`Poll error: ${err}`);
    });
  }, intervalMs);

  const shutdown = (signal: string): void => {
    console.log(`\nReceived ${signal} — shutting down...`);
    clearInterval(interval);
    for (const localPath of Object.values(config.repoLocalPaths ?? {})) {
      try {
        execFileSync("git", ["worktree", "prune"], { cwd: localPath, stdio: "ignore" });
      } catch { /* best effort */ }
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
