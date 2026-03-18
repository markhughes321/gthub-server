/**
 * CLI to clear the reviewed state, forcing all PRs to be re-reviewed.
 * Usage:
 *   npm run reset                  — clears everything
 *   npm run reset -- owner/repo    — clears all PRs for one repo
 *   npm run reset -- owner/repo 123 — clears a single PR
 */
import { loadState, saveState } from "./state.js";

function main(): void {
  const args = process.argv.slice(2);
  const state = loadState();
  const before = Object.keys(state.reviewed).length;

  if (args.length === 0) {
    state.reviewed = {};
    saveState(state);
    console.log(`Cleared all ${before} reviewed entr${before === 1 ? "y" : "ies"}.`);
    return;
  }

  const repo = args[0];
  const prNumber = args[1] ? parseInt(args[1], 10) : null;

  if (prNumber !== null && isNaN(prNumber)) {
    console.error(`Invalid PR number: ${args[1]}`);
    process.exit(1);
  }

  let removed = 0;
  for (const key of Object.keys(state.reviewed)) {
    if (prNumber !== null) {
      if (key === `${repo}#${prNumber}`) {
        delete state.reviewed[key];
        removed++;
      }
    } else {
      if (key.startsWith(`${repo}#`)) {
        delete state.reviewed[key];
        removed++;
      }
    }
  }

  saveState(state);
  console.log(`Removed ${removed} entr${removed === 1 ? "y" : "ies"} for ${prNumber !== null ? `${repo}#${prNumber}` : repo}.`);
}

main();
