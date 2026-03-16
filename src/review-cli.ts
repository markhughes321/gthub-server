/**
 * CLI for manually reviewing a single PR.
 * Usage: npm run review -- owner/repo 123
 */
import { loadConfig } from "./config.js";
import { listOpenPRs } from "./github.js";
import { reviewPR } from "./reviewer.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: npm run review -- owner/repo <pr-number>");
    process.exit(1);
  }

  const repo = args[0];
  const prNumber = parseInt(args[1], 10);

  if (isNaN(prNumber)) {
    console.error(`Invalid PR number: ${args[1]}`);
    process.exit(1);
  }

  const config = loadConfig();

  console.log(`Fetching ${repo}#${prNumber}...`);
  const prs = await listOpenPRs(repo);
  const pr = prs.find((p) => p.number === prNumber);

  if (!pr) {
    console.error(
      `PR #${prNumber} not found in ${repo} (or it is a draft/closed).`
    );
    process.exit(1);
  }

  console.log(`Reviewing: ${pr.title} by ${pr.author.login}`);
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
