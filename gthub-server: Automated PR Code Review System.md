# gthub-server: Automated PR Code Review System

## Context

Monitors GitHub PRs across configured repos, automatically reviews non-draft PRs using Claude Code, stores review output locally, and sends cross-platform notifications when reviews are ready.

## Architecture

**Node.js/TypeScript polling service** using `gh` CLI + `claude` CLI + `node-notifier`. Cross-platform (macOS + Windows).

```
Poll (setInterval every 5min)
  → gh pr list (filter non-draft, open)
  → Check state file (skip already-reviewed at same SHA)
  → For each new/updated PR:
      → gh pr view + gh pr diff (gather context)
      → claude -p (run review with prompt)
      → Save output to reviews/ folder
      → Cross-platform notification (node-notifier)
      → Update state file
```

## Project Structure

```
gthub-server/
├── config.json                     # Repos to watch, intervals, model settings
├── package.json                    # Node.js project (tsx for dev, tsc for build)
├── tsconfig.json
├── .claude/
│   └── commands/
│       └── code-review.md          # /code-review slash command (manual use)
├── src/
│   ├── index.ts                    # Polling entry point (npm start)
│   ├── review-cli.ts              # Manual single-PR review (npm run review)
│   ├── config.ts                   # Config loading
│   ├── github.ts                   # GitHub API via gh CLI
│   ├── reviewer.ts                 # Runs claude -p with review prompt
│   ├── notifier.ts                 # Cross-platform notifications (node-notifier)
│   ├── state.ts                    # Reviewed PR state tracking
│   └── types.ts                    # TypeScript interfaces
├── prompts/
│   └── review-prompt.md            # Review system prompt for Claude
├── state/
│   └── reviewed.json               # Tracks reviewed PRs by repo#number + SHA
├── reviews/                        # Output folder
│   └── {owner}-{repo}/
│       └── PR-{number}/
│           ├── review-{timestamp}.md
│           └── meta.json
└── logs/
```

## Usage

### Setup
```bash
npm install
# Edit config.json — add your repos to the "repos" array
```

### Automated polling
```bash
npm run dev     # Development (tsx, watches for changes)
npm run build   # Compile TypeScript
npm start       # Production (compiled JS)
```

### Manual single PR review
```bash
npm run review -- owner/repo 123
```

### Manual via Claude Code slash command
```
/code-review owner/repo#123
```

## Key Design Decisions

- **Node.js/TypeScript over shell scripts**: Cross-platform compatibility (macOS + Windows)
- **node-notifier**: Handles macOS Notification Center, Windows Toast, and Linux notify-send
- **Polling over webhooks**: No public URL needed, works entirely locally
- **setInterval over launchd/Task Scheduler**: Single cross-platform process, no OS-specific daemon config
- **Local-only output**: Reviews stored in `reviews/` folder (PR commenting available via config flag)
- **Specific repos**: User configures repos in `config.json`
- **Dual-mode**: `/code-review` works as manual Claude Code slash command AND automated polling
- **Confidence scoring**: Only reports issues with confidence >= 80 to minimize false positives
- **Re-review on new commits**: Tracks head SHA — re-reviews when commits are pushed

## Prerequisites

- [GitHub CLI (gh)](https://cli.github.com/) — `brew install gh` / `winget install GitHub.cli`
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — must be authenticated
- Node.js >= 18
