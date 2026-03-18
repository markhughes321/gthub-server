# revue

Automated GitHub PR code review system. Polls configured repositories for open pull requests, runs AI-powered reviews using Claude Code, and serves a real-time dashboard for monitoring results.

## How it works

1. Polls GitHub for open PRs on a configurable interval
2. Fetches the changed file list for each PR and classifies it (API / UI / MIXED / INFRA)
3. Creates an isolated git worktree for the PR commit
4. Runs a Claude Code skill against the worktree as a subprocess
5. Streams live output to the web dashboard via Server-Sent Events
6. Saves the review as a Markdown file and sends a desktop notification

## Prerequisites

- [Node.js](https://nodejs.org) v22+
- [Git](https://git-scm.com)
- [GitHub CLI](https://cli.github.com) (`gh`) — authenticated
- [Claude Code CLI](https://github.com/anthropics/claude-code) (`claude`) — authenticated

## Setup

```bash
git clone <repo>
cd revue
npm install
```

Copy and edit the config:

```bash
cp config.json config.json   # already present — edit it directly
```

Add a `.env.local` in each monitored repository root (used to pass the GitHub token to Claude):

```
GITHUB_PAT=ghp_yourtoken
```

## Configuration (`config.json`)

```jsonc
{
  // GitHub repositories to monitor (owner/repo format)
  "repos": ["KaseyaOne/kaseya-one-auto-tests"],

  // Local checkout path for each repo — used to create git worktrees
  "repoLocalPaths": {
    "KaseyaOne/kaseya-one-auto-tests": "C:/Users/you/Repos/kaseya-one-auto-tests"
  },

  // How often to poll GitHub for new PRs (seconds)
  "pollIntervalSeconds": 300,

  // Claude model to use for reviews
  "reviewModel": "claude-opus-4-6",

  // Desktop notifications when a review completes
  "notify": true,

  // PRs with >= this many changed files use the team review skill
  "teamReviewThreshold": 10,

  // Per-review timeout (minutes) before the Claude process is killed
  "reviewTimeoutMinutes": 15,

  // Run multiple reviews at the same time
  "parallelReviews": false,
  "maxConcurrentReviews": 3,

  // Map PR type → Claude skill name (overrides size-based selection)
  "skillMap": {
    "API": "api-500-hunter",
    "UI": "pr-review",
    "INFRA": "pr-review",
    "MIXED": "pr-review-team"
  },

  // Per-repo overrides (takes priority over skillMap)
  "repoSkillMap": {
    "owner/repo": {
      "API": "custom-skill"
    }
  }
}
```

### PR type classification

Files are classified into four types that drive skill selection:

| Type | Matched paths |
|------|--------------|
| `API` | `src/tests/.../APITests/`, `src/api/` |
| `UI` | `src/tests/Ui/`, `src/pages/`, `src/ui/` |
| `INFRA` | `playwright.config.ts`, `src/config/`, `src/utils/`, `.claude/` |
| `MIXED` | Both API and UI files in the same PR |

## Running

### Development

```bash
npm run dev
```

### Production (manual)

```bash
npm run build
npm start
```

### Dashboard

Open `http://localhost:3000` in a browser. The port can be changed via `"port"` in `config.json`.

## Process management (Windows)

The app runs under [PM2](https://pm2.keymetrics.io) for auto-restart on crash and auto-start on Windows login.

### First-time setup

```bash
npm install -g pm2
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

A Windows Task Scheduler task (`PM2 gthub-server`) was created to run `pm2 resurrect` at every login, restoring the saved process list automatically.

### Daily usage

| Task | Command |
|------|---------|
| Check status | `npm run status` |
| View live logs | `npm run logs` |
| Stop the app | `npm run stop` |
| Restart the app | `npm run restart` |
| Start after a manual stop | `pm2 start gthub-server` |

### Dashboard controls

The dashboard exposes process management endpoints:

| Endpoint | Effect |
|----------|--------|
| `GET /api/process/status` | Returns PM2 process info (or `{ managed: false }` if not running under PM2) |
| `POST /api/process/restart` | Restarts the process via PM2 |
| `POST /api/process/stop` | Stops the process via PM2; falls back to `process.exit(0)` if not under PM2 |

### PM2 config (`ecosystem.config.cjs`)

```
autorestart:   true
max_restarts:  10
restart_delay: 5000ms
min_uptime:    10s
logs:          logs/pm2-out.log, logs/pm2-err.log
```

Crashes that happen in under 10 seconds count against the `max_restarts` limit — this prevents a misconfigured startup from hammering the machine.

## Testing

```bash
npm test                # run all tests once
npm run test:watch      # re-run on file change
npm run test:coverage   # generate coverage report
```

### Test coverage

| File | What is tested |
|------|----------------|
| `src/reviewer.test.ts` | All 6 secret redaction patterns, stream JSON parsing, tool-use formatting, truncation |
| `src/pr-classifier.test.ts` | All PR type branches: API, UI, INFRA, MIXED, edge cases |
| `src/state.test.ts` | Load/save round-trip, corrupt JSON recovery, `needsReview` logic |
| `src/lock.test.ts` | Acquire, stale lock cleanup, release, re-acquire, concurrent block |

## PR locking

To prevent two running instances from reviewing the same PR simultaneously, the app uses file-based locks stored in `state/locks/`. Each lock file contains the owning process's PID. On acquisition, if a lock exists and the PID is no longer running (detected via `process.kill(pid, 0)`), the lock is treated as stale and overwritten. Locks are always released in the `finally` block of `reviewPR`.

## File layout

```
revue/
├── config.json             # user config
├── ecosystem.config.cjs    # PM2 process definition
├── src/
│   ├── index.ts            # entry point — poll loop
│   ├── reviewer.ts         # core review orchestration
│   ├── review-manager.ts   # in-memory review registry + SSE
│   ├── server.ts           # HTTP dashboard server
│   ├── state.ts            # persistent reviewed-PR state
│   ├── lock.ts             # per-PR file locks
│   ├── github.ts           # GitHub CLI wrappers
│   ├── worktree.ts         # git worktree lifecycle
│   ├── pr-classifier.ts    # PR type classification
│   ├── notifier.ts         # desktop notifications
│   └── config.ts           # config loading
├── reviews/                # saved review .md files (gitignored)
├── state/                  # reviewed.json + locks/ (gitignored)
├── worktrees/              # active git worktrees (gitignored)
└── logs/                   # PM2 stdout/stderr logs (gitignored)
```

## Security notes

- GitHub tokens are redacted from all dashboard output and log files before being written (patterns: `ghp_`, `ghs_`, `github_pat_`, `GH_TOKEN=`, etc.)
- Each review runs in an isolated git worktree — the main repository checkout is never modified
- Claude is invoked with an explicit tool allowlist (`Read`, `Write`, `Glob`, `Grep`, `Agent`, `WebFetch`, `TodoWrite`, `Bash(git:*)`, `Bash(gh:*)`, `Bash(npm:*)`, `Bash(node:*)`, `Bash(npx:*)`, `Bash(cat:*)`, `Bash(grep:*)`, `Bash(tail:*)`)
- The dashboard has no authentication — do not expose port 3000 to untrusted networks
