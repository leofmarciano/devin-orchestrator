const ANSI_OSC_REGEX = /\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)/g;
const ANSI_DCS_PM_APC_REGEX = /\u001B[PX^_][\s\S]*?(?:\u0007|\u001B\\|\u009C)/g;
const ANSI_CSI_REGEX =
  /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
const ANSI_ESC_TWO_CHAR_REGEX = /\u001B[@-Z\\-_]/g;
const C1_CONTROL_REGEX = /[\u0080-\u009F]/g;
const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Devin TUI chrome fragments that get spliced into pane captures mid-render.
const CHROME_CUT_MARKERS: RegExp[] = [
  /Context:\s*[\d.,]+\s*[kKmM]?\s*\/\s*[\d.,]+\s*[kKmM]?\s*tokens/i,
  /\((?:[^()]*)\s+on\)/i,
  /\bAsk Devin to build features\b/i,
  /Press opt\+/i,
  /\besc to interrupt\b/i,
  /[\u2022\u25E6]\s*(?:Searching the web|Planning|Gathering|Summarizing|Exploring|Confirming|Inspecting|Identifying)\b/i,
];

const CHROME_ONLY_LINE_PATTERNS: RegExp[] = [
  /^[-\u2500]+\s*Worked for\b/i,
  /^[\u2500-]{10,}$/i,
  /^[\u2022\u25E6\u203A>\u23FA]\s*(?:Searching the web|Planning|Gathering|Summarizing|Exploring|Confirming|Inspecting|Identifying)\b/i,
  /^(?:\d{1,3}% context left|esc to interrupt)\b/i,
  // Devin TUI banner, logo art (braille block), and status lines
  /[\u2800-\u28FF]/,
  /^\s*Welcome to Devin CLI!?/i,
  /^\s*Devin CLI\s*$/i,
  /^v\d+\.\d+(\.\d+)?\s*$/i,
  /^\s*\u2713?\s*Logged in as\b/i,
  /^\s*\u2713?\s*Organization:/i,
  /^\s*\u2713?\s*You're all set\b/i,
  /^\s*\u2713?\s*Restart your shell\b/i,
  /Context:\s*[\d.,]+\s*[kKmM]?\s*\/\s*[\d.,]+\s*[kKmM]?\s*tokens/i,
  // Status bar model label ("SWE-2 Medium", "Claude Opus 5.5 High Fast", ...)
  /^(?:SWE-\S+|SWE\s+\S+|Claude\s+\S+|GPT-\S+|Kimi\s+\S+|Adaptive|Fable)\s+(?:No Thinking|Low|Medium|High|XHigh|Max)(?:\s+(?:Thinking|Fast|Priority))*$/i,
  // Bare prompt chevron / box borders left after stripping
  /^[-\u2500\s]*\([^()]*\)\s*[-\u2500]*$/,
  /^\s*Guide Devin while it works\s*$/i,
  /rate a response/i,
  /^[\u276F\u276D]+\s*$/,
  /^[\u2500\u2502\u250C\u2510\u2514\u2518\u256D\u256E\u2570\u256F\s]*$/,
];

function stripControlSequences(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(ANSI_OSC_REGEX, "")
    .replace(ANSI_DCS_PM_APC_REGEX, "")
    .replace(ANSI_CSI_REGEX, "")
    .replace(ANSI_ESC_TWO_CHAR_REGEX, "")
    .replace(C1_CONTROL_REGEX, "")
    .replace(CONTROL_CHARS_REGEX, "");
}

function truncateAtFirstMarker(line: string, markers: RegExp[]): string {
  let cutoff = -1;

  for (const marker of markers) {
    const match = marker.exec(line);
    marker.lastIndex = 0;
    if (!match || match.index === undefined) continue;
    if (cutoff === -1 || match.index < cutoff) cutoff = match.index;
  }

  return cutoff >= 0 ? line.slice(0, cutoff) : line;
}

function isChromeOnlyLine(line: string): boolean {
  return CHROME_ONLY_LINE_PATTERNS.some((pattern) => pattern.test(line.trim()));
}

function stripKnownUrlArtifacts(line: string): string {
  let cleaned = line;

  if (/^https?:\/\//i.test(cleaned)) {
    cleaned = cleaned
      .replace(/(\/issues\/\d+)[A-Za-z].*$/i, "$1")
      .replace(/(\.(?:html|md|json|txt|pdf))[A-Za-z].*$/i, "$1")
      .replace(/(pgvector-\d+)[A-Za-z].*$/i, "$1")
      .replace(/(pgvector)[A-Za-z]{4,}$/i, "$1")
      .replace(/(released-\d+\/)[A-Za-z].*$/i, "$1")
      .replace(/\s+.*$/, "");
  } else {
    cleaned = cleaned
      .replace(/(https?:\/\/\S+?\/issues\/\d+)[A-Za-z].*$/i, "$1")
      .replace(/(https?:\/\/\S+?\.(?:html|md|json|txt|pdf))[A-Za-z].*$/i, "$1");
  }

  return cleaned;
}

function truncateAtInlineNoiseGlyph(line: string): string {
  const tail = line.slice(1);
  const match = /[\u2022\u25E6\u203A]/.exec(tail);
  if (!match || match.index === undefined) return line;
  return line.slice(0, match.index + 1);
}

function stripJoinedArtifactSuffix(line: string): string {
  let cleaned = line;

  // Remove redraw fragments that get appended directly after punctuation.
  cleaned = cleaned.replace(/([:)])([A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z0-9]{1,6}){1,})$/, "$1");
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = cleaned.replace(/(\.)(?!html$|md$|json$|txt$|pdf$)[A-Za-z]{4,}$/i, "$1");
    cleaned = cleaned.replace(/(\.)([A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z0-9]{1,24}){1,})$/, "$1");
  }

  return cleaned;
}

function isLikelyNoiseLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (/^\.\.\./.test(text)) return true;
  if (text.includes("...") && !/^- Inference:\s/i.test(text)) return true;
  if (
    /","(?:numResults|tokensNum|livecrawl|contextMaxCharacters|type)":/i.test(text) &&
    !/^[-*]\s+(?:Calling|Searched|Read|Ran|Explored)\b/i.test(text) &&
    !/^\u2514\s/.test(text)
  ) {
    return true;
  }
  if (/^partition key [a-z]{5,}$/i.test(text)) return true;
  return false;
}

function isLikelyTypingArtifact(line: string): boolean {
  const text = line.trim();
  if (text.length < 35) return false;
  if (/`|[{[\]}]/.test(text)) return false;

  const inlineGlyphs = (text.slice(1).match(/[\u2022\u25E6]/g) ?? []).length;
  if (inlineGlyphs >= 1) return true;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 10) return false;

  const alphaWords = words.filter((word) => /[a-z]/i.test(word));
  if (alphaWords.length < 10) return false;

  const shortWords = alphaWords.filter((word) => word.length <= 4).length;
  const longWords = alphaWords.filter((word) => word.length >= 8).length;
  const shortRatio = shortWords / alphaWords.length;
  const repeatedShortWords = /(?:\b[a-z]{1,4}\b\s+){8,}\b[a-z]{1,4}\b/i.test(text);
  const doubledPairs = (text.match(/([A-Za-z])\1/g) ?? []).length;

  if (doubledPairs >= 3) return true;
  if (/^\s*[-*#]/.test(text) && (shortRatio < 0.75 || longWords > 1)) return false;
  if (/[.;:!?]/.test(text) && shortRatio < 0.75 && longWords > 1) return false;

  return shortRatio >= 0.8 && longWords <= 1 && repeatedShortWords;
}

function normalizeSubstantiveLine(line: string): string {
  return line
    .replace(/^\s*[\u203A>\u276D]\s+/, "")
    .replace(/^\s*[\u2022\u25E6\u23FA]\s+/, "- ")
    .replace(/^\s*\u2713\s+/, "- ")
    .trimEnd();
}

export function stripAnsiCodes(text: string): string {
  return stripControlSequences(text);
}

export function cleanTerminalOutput(text: string): string {
  const stripped = stripControlSequences(text);
  const outputLines: string[] = [];
  let previousLine = "";

  for (const rawLine of stripped.split("\n")) {
    let line = rawLine.replace(/\uFFFD/g, "").trimEnd();
    if (!line.trim()) {
      if (outputLines.length > 0 && outputLines[outputLines.length - 1] !== "") {
        outputLines.push("");
      }
      continue;
    }

    line = truncateAtFirstMarker(line, CHROME_CUT_MARKERS);
    line = truncateAtInlineNoiseGlyph(line);
    line = stripKnownUrlArtifacts(line);
    line = stripJoinedArtifactSuffix(line);
    line = normalizeSubstantiveLine(line).trim();

    if (!line) continue;
    if (isChromeOnlyLine(line)) continue;
    if (isLikelyNoiseLine(line)) continue;
    if (isLikelyTypingArtifact(line)) continue;

    if (line === previousLine) continue;
    outputLines.push(line);
    previousLine = line;
  }

  while (outputLines.length > 0 && outputLines[outputLines.length - 1] === "") {
    outputLines.pop();
  }

  return outputLines.join("\n");
}
