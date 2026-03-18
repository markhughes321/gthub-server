import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { execFile } from "child_process";
import { createHmac, timingSafeEqual } from "crypto";
import { readFileSync, existsSync } from "fs";
import { readdir, readFile, writeFile } from "fs/promises";
import { join, dirname, basename, resolve as resolvePath } from "path";
import { fileURLToPath } from "url";
import { loadConfig, getProjectRoot } from "./config.js";
import { listOpenPRs } from "./github.js";
import { loadState, needsReview, hideReview } from "./state.js";
import { reviewPR } from "./reviewer.js";
import * as manager from "./review-manager.js";
import { getQueue } from "./queue.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const CLAUDE_ROOT = join(__dirname, "..", ".claude");

interface FileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileNode[];
}

async function buildFileTree(dir: string): Promise<FileNode[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = fullPath.slice(CLAUDE_ROOT.length + 1).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: relPath, type: "dir", children: await buildFileTree(fullPath) });
    } else {
      nodes.push({ name: entry.name, path: relPath, type: "file" });
    }
  }
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

export function startServer(port: number): void {
  let dashboardHtml: string;
  try {
    dashboardHtml = readFileSync(join(PUBLIC_DIR, "index.html"), "utf-8");
  } catch {
    dashboardHtml = "<pre>Dashboard not found. Ensure public/index.html exists.</pre>";
  }

  createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // GET / — dashboard
    if (method === "GET" && path === "/") {
      return send(res, 200, "text/html; charset=utf-8", dashboardHtml);
    }

    // GET /*.js — static JS files from public/ (e.g. marked.min.js)
    if (method === "GET" && /^\/[a-zA-Z0-9._-]+\.js$/.test(path)) {
      const filePath = join(PUBLIC_DIR, basename(path));
      if (existsSync(filePath)) {
        return send(res, 200, "application/javascript; charset=utf-8", readFileSync(filePath, "utf-8"));
      }
    }

    // GET /api/reviews — list all
    if (method === "GET" && path === "/api/reviews") {
      return send(res, 200, "application/json", JSON.stringify(manager.getAll()));
    }

    // GET /api/reviews/:id/stream — SSE
    const streamMatch = path.match(/^\/api\/reviews\/([^/]+)\/stream$/);
    if (method === "GET" && streamMatch) {
      const id = decodeURIComponent(streamMatch[1]);
      const data = manager.get(id);
      if (!data) return send(res, 404, "text/plain", "Review not found");

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.flushHeaders();

      // Replay buffered chunks
      for (const chunk of data.chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      // Already done — send sentinel and close
      if (data.info.status !== "running") {
        res.write(`event: done\ndata: ${JSON.stringify(data.info.status)}\n\n`);
        return res.end();
      }

      const unsubscribe = manager.subscribe(
        id,
        (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`),
        (status) => {
          res.write(`event: done\ndata: ${JSON.stringify(status)}\n\n`);
          res.end();
        }
      );

      req.on("close", () => unsubscribe?.());
      return;
    }

    // GET /api/reviews/:id/log — serve the activity log file
    const logMatch = path.match(/^\/api\/reviews\/([^/]+)\/log$/);
    if (method === "GET" && logMatch) {
      const id = decodeURIComponent(logMatch[1]);
      const data = manager.get(id);
      if (!data?.info.reviewPath) return send(res, 404, "text/plain", "Review not found");
      const logFilePath = join(getProjectRoot(), data.info.reviewPath.replace(/\.md$/, ".log"));
      if (!existsSync(logFilePath)) return send(res, 404, "text/plain", "Log not available");
      return send(res, 200, "text/plain; charset=utf-8", readFileSync(logFilePath, "utf-8"));
    }

    // GET /api/reviews/:id/meta — serve the PR meta.json
    const metaMatch = path.match(/^\/api\/reviews\/([^/]+)\/meta$/);
    if (method === "GET" && metaMatch) {
      const id = decodeURIComponent(metaMatch[1]);
      const data = manager.get(id);
      if (!data?.info.reviewPath) return send(res, 404, "text/plain", "Review not found");
      const metaFilePath = join(getProjectRoot(), data.info.reviewPath.replace(/\/review-[^/]+\.md$/, "/meta.json"));
      if (!existsSync(metaFilePath)) return send(res, 404, "text/plain", "Meta not available");
      return send(res, 200, "application/json; charset=utf-8", readFileSync(metaFilePath, "utf-8"));
    }

    // GET /api/reviews/:id/content — serve the finished markdown file
    const contentMatch = path.match(/^\/api\/reviews\/([^/]+)\/content$/);
    if (method === "GET" && contentMatch) {
      const id = decodeURIComponent(contentMatch[1]);
      const data = manager.get(id);
      if (!data?.info.reviewPath) return send(res, 404, "text/plain", "Review not found");
      const filePath = join(getProjectRoot(), data.info.reviewPath);
      if (!existsSync(filePath)) return send(res, 404, "text/plain", "File not written yet");
      return send(res, 200, "text/plain; charset=utf-8", readFileSync(filePath, "utf-8"));
    }

    // GET /api/prs/:encodedRepo/:prNumber/reviews — all review snapshots for a PR
    const prHistoryMatch = path.match(/^\/api\/prs\/([^/]+)\/(\d+)\/reviews$/);
    if (method === "GET" && prHistoryMatch) {
      const repo = decodeURIComponent(prHistoryMatch[1]);
      const prNumber = parseInt(prHistoryMatch[2], 10);
      const safeRepo = repo.replace(/\//g, "-");
      const prDir = join(getProjectRoot(), "reviews", safeRepo, `PR-${prNumber}`);
      if (!existsSync(prDir)) return send(res, 200, "application/json", "[]");
      try {
        const entries = await readdir(prDir);
        const reviewFiles = entries
          .filter((f) => f.startsWith("review-") && f.endsWith(".md"))
          .sort().reverse(); // newest first
        const snapshots = reviewFiles.map((f) => {
          const ts = f.replace(/^review-/, "").replace(/\.md$/, "");
          const metaPath = join(prDir, "meta.json");
          let meta: Record<string, unknown> = {};
          try { meta = JSON.parse(readFileSync(metaPath, "utf-8")); } catch { /* no meta */ }
          return {
            reviewPath: `reviews/${safeRepo}/PR-${prNumber}/${f}`,
            timestamp: ts,
            headSha: meta.headSha ?? null,
            model: meta.reviewModel ?? null,
            status: "complete",
          };
        });
        return send(res, 200, "application/json", JSON.stringify(snapshots));
      } catch {
        return send(res, 500, "text/plain", "Failed to list reviews");
      }
    }

    // GET /api/reviews/file?path=... — serve any review markdown by relative path
    if (method === "GET" && path === "/api/reviews/file") {
      const relPath = url.searchParams.get("path") ?? "";
      if (!relPath.startsWith("reviews/") || relPath.includes("..")) {
        return send(res, 403, "text/plain", "Forbidden");
      }
      const absPath = join(getProjectRoot(), relPath);
      if (!existsSync(absPath)) return send(res, 404, "text/plain", "Not found");
      return send(res, 200, "text/plain; charset=utf-8", readFileSync(absPath, "utf-8"));
    }

    // DELETE /api/reviews/:id — kill
    const killMatch = path.match(/^\/api\/reviews\/([^/]+)$/);
    if (method === "DELETE" && killMatch) {
      const id = decodeURIComponent(killMatch[1]);
      const killed = manager.killReview(id);
      return send(res, killed ? 200 : 404, "application/json", JSON.stringify({ killed }));
    }

    // POST /api/reviews/:id/hide — hide a completed review from the dashboard
    // The state entry (headSha) is preserved so the PR won't be re-reviewed
    const hideMatch = path.match(/^\/api\/reviews\/([^/]+)\/hide$/);
    if (method === "POST" && hideMatch) {
      const id = decodeURIComponent(hideMatch[1]);
      const data = manager.get(id);
      if (!data || data.info.status === "running") {
        return send(res, 400, "application/json", JSON.stringify({ error: "Cannot hide a running review" }));
      }
      const state = loadState();
      hideReview(state, data.info.repo, data.info.prNumber);
      manager.dismissReview(id);
      return send(res, 200, "application/json", JSON.stringify({ hidden: true }));
    }

    // POST /api/reviews/:id/retry — re-trigger any non-running review, optionally with a skill override
    const retryMatch = path.match(/^\/api\/reviews\/([^/]+)\/retry$/);
    if (method === "POST" && retryMatch) {
      const id = decodeURIComponent(retryMatch[1]);
      const data = manager.get(id);
      if (!data || data.info.status === "running") {
        return send(res, 400, "application/json", JSON.stringify({ error: "Not retryable" }));
      }
      const { repo, prNumber } = data.info;
      const alreadyRunning = manager.getAll().some(
        (r) => r.repo === repo && r.prNumber === prNumber && r.status === "running"
      );
      if (alreadyRunning) {
        return send(res, 409, "application/json", JSON.stringify({ error: "Review already running for this PR" }));
      }
      const rawBody = await readBody(req);
      let skillOverride: string | undefined;
      try {
        const parsed = JSON.parse(rawBody);
        if (parsed.skill && typeof parsed.skill === "string") skillOverride = parsed.skill;
      } catch { /* no body or non-JSON — use auto skill selection */ }
      const config = loadConfig();
      getQueue().enqueue(
        () =>
          listOpenPRs(repo)
            .then((prs) => {
              const pr = prs.find((p) => p.number === prNumber);
              if (!pr) throw new Error(`PR #${prNumber} not found or closed`);
              return reviewPR(config, pr, repo, skillOverride);
            })
            .then(() => {})
            .catch((err) => console.error(`Retry failed for ${repo}#${prNumber}: ${err}`)),
        { repo, prNumber, title: data.info.title, url: data.info.url }
      );
      return send(res, 202, "application/json", JSON.stringify({ queued: true }));
    }

    // GET /api/queue — queue status with pending items
    if (method === "GET" && path === "/api/queue") {
      const q = getQueue();
      return send(res, 200, "application/json", JSON.stringify({
        active: q.active,
        pending: q.pending,
        items: q.pendingItems,
      }));
    }

    // POST /webhook — GitHub PR webhook
    const config2 = loadConfig();
    const webhookPath = config2.webhookPath ?? "/webhook";
    if (method === "POST" && path === webhookPath) {
      // Read raw body (needed for HMAC verification)
      const rawBody = await readBody(req);

      // Verify signature if webhookSecret is configured
      if (config2.webhookSecret) {
        const sigHeader = (req.headers["x-hub-signature-256"] as string) ?? "";
        const expected = "sha256=" + createHmac("sha256", config2.webhookSecret)
          .update(rawBody, "utf-8").digest("hex");
        const sigBuf = Buffer.from(sigHeader.padEnd(expected.length));
        const expBuf = Buffer.from(expected);
        if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
          return send(res, 401, "text/plain", "Invalid signature");
        }
      }

      const event = req.headers["x-github-event"] as string;
      if (event !== "pull_request") {
        return send(res, 200, "application/json", JSON.stringify({ skipped: true, event }));
      }

      let payload: { action?: string; repository?: { full_name?: string }; pull_request?: { number?: number } };
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return send(res, 400, "text/plain", "Invalid JSON");
      }

      const action = payload.action;
      const repo = payload.repository?.full_name;
      const prNumber = payload.pull_request?.number;

      if (!action || !repo || !prNumber) {
        return send(res, 400, "text/plain", "Missing fields");
      }

      if (!["opened", "synchronize", "reopened"].includes(action)) {
        return send(res, 200, "application/json", JSON.stringify({ skipped: true, action }));
      }

      if (!config2.repos.includes(repo)) {
        return send(res, 200, "application/json", JSON.stringify({ skipped: true, reason: "repo not configured" }));
      }

      // Check needsReview before triggering to avoid duplicate with poll
      getQueue().enqueue(
        () =>
          listOpenPRs(repo)
            .then((prs) => {
              const pr = prs.find((p) => p.number === prNumber);
              if (!pr) return;
              const state = loadState();
              if (!needsReview(state, repo, prNumber, pr.headRefOid)) {
                console.log(`[webhook] Skip ${repo}#${prNumber} — already reviewed at this SHA`);
                return;
              }
              console.log(`[webhook] Triggering review for ${repo}#${prNumber} (action: ${action})`);
              return reviewPR(config2, pr, repo).then(() => {});
            })
            .catch((err) => console.error(`[webhook] Error for ${repo}#${prNumber}: ${err}`)),
        { repo, prNumber }
      );

      return send(res, 202, "application/json", JSON.stringify({ queued: true, repo, prNumber }));
    }

    // GET /api/claude-files — directory tree
    if (method === "GET" && path === "/api/claude-files") {
      try {
        const tree = await buildFileTree(CLAUDE_ROOT);
        return send(res, 200, "application/json", JSON.stringify(tree));
      } catch {
        return send(res, 500, "text/plain", "Failed to read .claude directory");
      }
    }

    // GET /api/claude-files/* — read file | PUT — write file
    const claudeFileMatch = path.match(/^\/api\/claude-files\/(.+)$/);
    if (claudeFileMatch) {
      const relPath = decodeURIComponent(claudeFileMatch[1]);
      const fullPath = resolvePath(join(CLAUDE_ROOT, relPath));
      if (!fullPath.startsWith(CLAUDE_ROOT)) {
        return send(res, 403, "text/plain", "Forbidden");
      }
      if (method === "GET") {
        try {
          const content = await readFile(fullPath, "utf-8");
          return send(res, 200, "text/plain; charset=utf-8", content);
        } catch {
          return send(res, 404, "text/plain", "File not found");
        }
      }
      if (method === "PUT") {
        try {
          const body = await readBody(req);
          await writeFile(fullPath, body, "utf-8");
          return send(res, 200, "application/json", JSON.stringify({ ok: true }));
        } catch {
          return send(res, 500, "text/plain", "Failed to write file");
        }
      }
    }

    // GET /api/process/status — PM2 process info
    if (method === "GET" && path === "/api/process/status") {
      return new Promise<void>((resolve) => {
        execFile("pm2", ["describe", "gthub-server", "--json"], { shell: true }, (_err, stdout) => {
          try {
            const info = JSON.parse(stdout);
            send(res, 200, "application/json", JSON.stringify({ managed: true, info }));
          } catch {
            send(res, 200, "application/json", JSON.stringify({ managed: false }));
          }
          resolve();
        });
      });
    }

    // POST /api/process/restart — restart via PM2
    if (method === "POST" && path === "/api/process/restart") {
      execFile("pm2", ["restart", "gthub-server"], { shell: true }, (err) => {
        if (err) console.error("[process] PM2 restart failed:", err.message);
      });
      return send(res, 200, "application/json", JSON.stringify({ ok: true }));
    }

    // POST /api/process/stop — stop via PM2, fall back to self-exit
    if (method === "POST" && path === "/api/process/stop") {
      send(res, 200, "application/json", JSON.stringify({ ok: true }));
      execFile("pm2", ["stop", "gthub-server"], { shell: true }, (err) => {
        if (err) {
          // Not running under PM2 — kill the current process directly
          process.exit(0);
        }
      });
      return;
    }

    send(res, 404, "text/plain", "Not found");
  }).listen(port, () => {
    console.log(`  Dashboard: http://localhost:${port}`);
  });
}
