---
description: "Review a GitHub pull request for bugs, security issues, and code quality"
argument-hint: "owner/repo#number (e.g. markhughes/my-app#42)"
allowed-tools:
  - Bash(gh:*)
  - Read
  - Grep
  - Glob
  - Write
---

# Code Review a Pull Request

Review the pull request specified in: "$ARGUMENTS"

## Process

### Step 1: Parse the PR reference

Extract the repo (`owner/repo`) and PR number from the argument. Supported formats:
- `owner/repo#123`
- `owner/repo 123`
- `https://github.com/owner/repo/pull/123`

If no argument provided, ask the user for a PR reference.

### Step 2: Check eligibility

Run these checks using `gh`. Skip the review if the PR is:
- (a) Closed or merged
- (b) A draft
- (c) An automated/bot PR that clearly needs no review

```bash
gh pr view <number> --repo <owner/repo> --json state,isDraft,author
```

### Step 3: Gather context

Fetch the PR metadata and diff:

```bash
gh pr view <number> --repo <owner/repo> --json title,body,author,labels,files,commits,baseRefName,headRefName,additions,deletions,changedFiles
```

```bash
gh pr diff <number> --repo <owner/repo>
```

Also check for CLAUDE.md files in the repo root and in directories touched by the PR.

### Step 4: Review the changes

Analyze the diff for issues. For each potential issue, assign a confidence score (0-100):

- **0**: Not confident — false positive or pre-existing issue
- **25**: Somewhat confident — might be real
- **50**: Moderately confident — real but minor/nitpick
- **75**: Highly confident — verified real issue impacting functionality
- **100**: Absolutely certain — confirmed real issue

**Only report issues with confidence >= 80.**

Focus on:
- Logic errors and bugs
- Missing error handling
- Race conditions
- Security vulnerabilities (injection, auth bypass, data exposure)
- Null/undefined handling
- Resource leaks
- Off-by-one errors
- Breaking changes to public interfaces

Ignore:
- Pre-existing issues not introduced in this PR
- Stylistic preferences not in project guidelines
- Issues linters/type checkers/CI will catch
- Clearly intentional functionality changes
- Issues on unmodified lines

### Step 5: Save the review

Save the review output to the reviews folder:

```
reviews/{owner}-{repo}/PR-{number}/review-{YYYYMMDD}-{HHMMSS}.md
```

Also save a `meta.json` with PR metadata (title, author, URL, SHA, timestamp).

### Step 6: Notify

Run this to send a macOS/Windows notification:
```bash
# macOS
osascript -e 'display notification "Review complete for <repo>#<number>" with title "Code Review" sound name "Glass"' 2>/dev/null

# Windows (PowerShell) — fallback if osascript not available
powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Review complete for <repo>#<number>', 'Code Review')" 2>/dev/null
```

### Step 7: Present results

Display the review to the user in this format:

```markdown
# Code Review: owner/repo#123

**PR Title:** [title]
**Author:** [author]
**Files Changed:** [count]

## Summary
[1-2 sentence assessment]

## Issues Found

### Critical (confidence 90-100)
[Issues or "None found."]

### Important (confidence 80-89)
[Issues or "None found."]

For each issue:
- **File:** [path]
- **Lines:** [line range]
- **Confidence:** [score]
- **Description:** [explanation]
- **Suggestion:** [fix]

## Positive Observations
[What's done well]
```

If no issues found with confidence >= 80, report: "No significant issues found."
