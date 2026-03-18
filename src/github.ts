import { execFile } from "child_process";
import { promisify } from "util";
import type { PullRequest } from "./types.js";

const execFileAsync = promisify(execFile);

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function listOpenPRs(repo: string): Promise<PullRequest[]> {
  const json = await gh([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--json",
    "number,title,headRefOid,isDraft,state,author,url,baseRefName,headRefName,additions,deletions,changedFiles",
  ]);

  const prs: PullRequest[] = JSON.parse(json || "[]");
  return prs.filter((pr) => !pr.isDraft);
}

export async function getPRView(
  repo: string,
  prNumber: number
): Promise<string> {
  return gh([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "title,body,author,labels,files,commits,baseRefName,headRefName,additions,deletions,changedFiles",
  ]);
}

export async function getPRDiff(
  repo: string,
  prNumber: number
): Promise<string> {
  return gh(["pr", "diff", String(prNumber), "--repo", repo]);
}

export async function getPRFileList(
  repo: string,
  prNumber: number
): Promise<string[]> {
  const output = await gh([
    "pr",
    "diff",
    String(prNumber),
    "--repo",
    repo,
    "--name-only",
  ]);
  return output.split("\n").filter((f) => f.trim().length > 0);
}
