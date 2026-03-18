export type PRType = "API" | "UI" | "MIXED" | "INFRA";

const API_PATTERNS = [
  /src\/tests\/[^/]+\/APITests\//,
  /src\/api\//,
];

const UI_PATTERNS = [
  /src\/tests\/Ui\//,
  /src\/pages\//,
  /src\/ui\//,
];

const INFRA_PATTERNS = [
  /playwright\.config\.ts$/,
  /src\/config\//,
  /src\/utils\//,
  /\.claude\//,
];

function matchesAny(file: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(file));
}

export function classifyPR(files: string[]): PRType {
  let hasApi = false;
  let hasUi = false;
  let hasNonInfra = false;

  for (const file of files) {
    if (matchesAny(file, API_PATTERNS)) {
      hasApi = true;
      hasNonInfra = true;
    } else if (matchesAny(file, UI_PATTERNS)) {
      hasUi = true;
      hasNonInfra = true;
    } else if (!matchesAny(file, INFRA_PATTERNS)) {
      hasNonInfra = true;
    }
  }

  if (hasApi && hasUi) return "MIXED";
  if (hasApi) return "API";
  if (hasUi) return "UI";
  return "INFRA";
}
