export interface SeveritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

// Heading or bold labels that map to severity levels
const CRITICAL_RE = /\b(critical|blocker|blocking|p0)\b/i;
const HIGH_RE     = /\b(high|major|p1)\b/i;
const MEDIUM_RE   = /\b(medium|moderate|warning|p2)\b/i;
const LOW_RE      = /\b(low|minor|suggestion|nit|p3|p4)\b/i;

// Emoji shortcuts
const EMOJI_CRITICAL = /🔴|🚨|❌/g;
const EMOJI_HIGH     = /🟠|⚠️/g;
const EMOJI_MEDIUM   = /🟡/g;
const EMOJI_LOW      = /🟢|💡/g;

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/**
 * Parse a completed review markdown for severity signals.
 * Counts occurrences across:
 *   - Table rows where the first cell matches a severity keyword
 *   - Bold keywords (e.g. **CRITICAL**)
 *   - Heading lines containing severity words (e.g. "## Critical Issues")
 *   - Emoji markers
 */
export function parseSeverity(markdown: string): SeveritySummary {
  const summary: SeveritySummary = { critical: 0, high: 0, medium: 0, low: 0 };

  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();

    // Table row: | Critical | ... or | High | ...
    const tableCell = trimmed.match(/^\|\s*\*{0,2}([^|*]+?)\*{0,2}\s*\|/);
    if (tableCell) {
      const cell = tableCell[1].trim();
      if (CRITICAL_RE.test(cell)) { summary.critical++; continue; }
      if (HIGH_RE.test(cell))     { summary.high++;     continue; }
      if (MEDIUM_RE.test(cell))   { summary.medium++;   continue; }
      if (LOW_RE.test(cell))      { summary.low++;      continue; }
    }

    // Bold keyword anywhere: **Critical**, **HIGH**, etc.
    const boldMatches = [...trimmed.matchAll(/\*\*([^*]+)\*\*/g)];
    for (const m of boldMatches) {
      const word = m[1];
      if (CRITICAL_RE.test(word)) summary.critical++;
      else if (HIGH_RE.test(word)) summary.high++;
      else if (MEDIUM_RE.test(word)) summary.medium++;
      else if (LOW_RE.test(word)) summary.low++;
    }

    // Heading lines: ## Critical Issues
    if (/^#{1,4}\s/.test(trimmed)) {
      if (CRITICAL_RE.test(trimmed)) summary.critical++;
      else if (HIGH_RE.test(trimmed)) summary.high++;
      else if (MEDIUM_RE.test(trimmed)) summary.medium++;
      else if (LOW_RE.test(trimmed)) summary.low++;
    }
  }

  // Emoji counts (global, whole document)
  summary.critical += countMatches(markdown, EMOJI_CRITICAL);
  summary.high     += countMatches(markdown, EMOJI_HIGH);
  summary.medium   += countMatches(markdown, EMOJI_MEDIUM);
  summary.low      += countMatches(markdown, EMOJI_LOW);

  return summary;
}

export function hasSeverity(s: SeveritySummary): boolean {
  return s.critical > 0 || s.high > 0 || s.medium > 0 || s.low > 0;
}
