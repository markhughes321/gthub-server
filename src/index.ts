import { loadConfig } from "./config.js";
import { listOpenPRs } from "./github.js";
import { loadState, needsReview } from "./state.js";
import { reviewPR } from "./reviewer.js";

async function poll(): Promise<void> {
  const config = loadConfig();
  const state = loadState();

  console.log(
    `[${new Date().toISOString()}] Polling ${config.repos.length} repo(s)...`
  );

  for (const repo of config.repos) {
    try {
      const prs = await listOpenPRs(repo);
      console.log(
        `  ${repo}: ${prs.length} open non-draft PR(s)`
      );

      for (const pr of prs) {
        if (!needsReview(state, repo, pr.number, pr.headRefOid)) {
          console.log(
            `  Skip ${repo}#${pr.number} (already reviewed at ${pr.headRefOid.slice(0, 7)})`
          );
          continue;
        }

        console.log(
          `  Reviewing ${repo}#${pr.number}: ${pr.title}`
        );
        await reviewPR(config, pr, repo);
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

  console.log("gthub-server started");
  console.log(`  Repos: ${config.repos.join(", ")}`);
  console.log(`  Poll interval: ${config.pollIntervalSeconds}s`);
  console.log(`  Model: ${config.reviewModel}`);
  console.log(`  Budget per review: $${config.maxBudgetUsd}`);
  console.log("");

  // Run immediately on start
  await poll();

  // Then poll on interval
  setInterval(() => {
    poll().catch((err) => {
      console.error(`Poll error: ${err}`);
    });
  }, intervalMs);
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
