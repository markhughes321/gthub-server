import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  copyFileSync,
  symlinkSync,
} from "fs";
import { join } from "path";

const execFileAsync = promisify(execFile);

export interface WorktreeHandle {
  path: string;
  cleanup: () => Promise<void>;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function linkResource(
  localRepoPath: string,
  worktreePath: string,
  relativePath: string,
  type: "junction" | "file-copy"
): void {
  const src = join(localRepoPath, relativePath);
  const dest = join(worktreePath, relativePath);

  if (!existsSync(src)) {
    console.warn(`[worktree] ${relativePath} not found in ${localRepoPath} — skipping`);
    return;
  }

  if (existsSync(dest)) return; // already linked

  if (type === "junction") {
    // Ensure parent dir exists
    const parentDir = join(worktreePath, relativePath.split("/").slice(0, -1).join("/"));
    if (parentDir !== worktreePath) mkdirSync(parentDir, { recursive: true });
    symlinkSync(src, dest, "junction");
  } else {
    copyFileSync(src, dest);
  }
}

export async function createWorktree(
  localRepoPath: string,
  prNumber: number,
  headSha: string,
  branchName: string,
  projectRoot: string
): Promise<WorktreeHandle> {
  const sha7 = headSha.slice(0, 7);
  const worktreePath = join(projectRoot, "worktrees", `PR-${prNumber}-${sha7}`);

  // Remove any leftover worktree from a previous crash — including the case
  // where the directory was deleted externally but git's metadata is still locked.
  if (existsSync(worktreePath)) {
    console.warn(`[worktree] Stale worktree found at ${worktreePath} — removing`);
    try {
      await git(["worktree", "remove", worktreePath, "--force"], localRepoPath);
    } catch {
      // If git worktree remove fails (e.g. not registered), just proceed —
      // git worktree add will error clearly if the dir is truly in the way
    }
  } else {
    // Directory missing but git metadata may still hold a locked entry.
    // Unlock (ignoring failure if not locked) then prune to clear stale refs.
    try { await git(["worktree", "unlock", worktreePath], localRepoPath); } catch { /* not locked */ }
    try { await git(["worktree", "prune"], localRepoPath); } catch { /* best effort */ }
  }

  // Fetch by branch name — the repo's refspec only covers named branches,
  // raw SHA fetches would fail for non-develop branches
  await git(["fetch", "origin", branchName], localRepoPath);

  // Create isolated worktree at exact PR commit (detached HEAD)
  await git(["worktree", "add", worktreePath, headSha], localRepoPath);

  // --- Link gitignored resources required by the skill ---

  // node_modules: junction (no admin required on Windows)
  linkResource(localRepoPath, worktreePath, "node_modules", "junction");

  // playwright/.auth: junction — contains accountManager.json, billingTeam.json,
  // user.json, supportTeam.json, sysadmin.json
  linkResource(localRepoPath, worktreePath, "playwright/.auth", "junction");

  // .claude/scripts: junction — contains extract-swagger-endpoint.cjs and other
  // helper scripts that are gitignored but required by the pr-review skill
  linkResource(localRepoPath, worktreePath, ".claude/scripts", "junction");

  // .env.local: file copy (file symlinks require Developer Mode on Windows)
  linkResource(localRepoPath, worktreePath, ".env.local", "file-copy");

  // Warn if package.json differs — node_modules junction may not match PR deps
  try {
    const mainPkg = readFileSync(join(localRepoPath, "package.json"), "utf-8");
    const wtPkg = readFileSync(join(worktreePath, "package.json"), "utf-8");
    if (mainPkg !== wtPkg) {
      console.warn(
        `[worktree] PR #${prNumber} has package.json changes — shared node_modules ` +
        `junction may not match PR dependencies. check-types/lint results could be inaccurate.`
      );
    }
  } catch { /* files may not exist in worktree — skip warning */ }

  const cleanup = async (): Promise<void> => {
    try {
      await git(["worktree", "remove", worktreePath, "--force"], localRepoPath);
    } catch {
      console.warn(
        `[worktree] Could not remove ${worktreePath} — run 'git worktree prune' in ${localRepoPath} manually`
      );
    }
  };

  return { path: worktreePath, cleanup };
}

export async function cleanupOrphanedWorktrees(
  projectRoot: string,
  repoLocalPaths: Record<string, string>
): Promise<void> {
  const worktreesDir = join(projectRoot, "worktrees");
  if (!existsSync(worktreesDir)) return;

  const localPaths = Object.values(repoLocalPaths);
  if (localPaths.length === 0) return;

  let entries: string[];
  try {
    entries = readdirSync(worktreesDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(worktreesDir, entry);
    let removed = false;
    for (const localRepoPath of localPaths) {
      try {
        execFileSync("git", ["worktree", "remove", fullPath, "--force"], {
          cwd: localRepoPath,
          stdio: "ignore",
        });
        console.log(`[worktree] Cleaned up orphaned worktree: ${entry}`);
        removed = true;
        break;
      } catch { /* try next repo */ }
    }
    if (!removed) {
      console.warn(`[worktree] Could not remove orphaned worktree ${entry} — skipping`);
    }
  }
}
