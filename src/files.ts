// File utilities for codebase map injection

import { readFileSync } from "fs";
import { resolve } from "path";

export interface CodebaseMapFile {
  path: string;
  content: string;
}

export function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

export async function findCodebaseMap(cwd: string): Promise<CodebaseMapFile | null> {
  const mapPaths = [
    resolve(cwd, "docs/CODEBASE_MAP.md"),
    resolve(cwd, "CODEBASE_MAP.md"),
    resolve(cwd, "docs/ARCHITECTURE.md"),
  ];

  for (const mapPath of mapPaths) {
    try {
      const content = readFileSync(mapPath, "utf-8");
      return { path: mapPath, content };
    } catch {
      // Try next path
    }
  }

  return null;
}

export async function loadCodebaseMap(cwd: string): Promise<string | null> {
  const map = await findCodebaseMap(cwd);
  return map?.content ?? null;
}
