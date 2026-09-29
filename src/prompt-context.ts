import { Buffer } from "node:buffer";
import { estimateTokens, findCodebaseMap } from "./files.ts";

export type PromptContextComponentKind = "map_wrapper" | "codebase_map" | "task_prompt";

export interface PromptContextTextEstimate {
  bytes: number;
  estimatedTokens: number;
}

export interface CartographerMapMetadata {
  totalTokens: number | null;
}

export interface PromptContextComponent extends PromptContextTextEstimate {
  kind: PromptContextComponentKind;
  label: string;
}

export interface PromptContextMapAccounting extends PromptContextTextEstimate {
  included: boolean;
  path: string | null;
  cartographerTotalTokens: number | null;
}

export interface PromptContextAccounting extends PromptContextTextEstimate {
  taskPrompt: PromptContextTextEstimate;
  map: PromptContextMapAccounting;
  components: PromptContextComponent[];
}

export interface BuildPromptContextOptions {
  taskPrompt: string;
  includeMap?: boolean;
  cwd?: string;
  mapContent?: string | null;
  mapPath?: string | null;
}

export interface BuiltPromptContext {
  prompt: string;
  accounting: PromptContextAccounting;
}

const MAP_PREFIX = "## Codebase Map\n\n";
const MAP_SUFFIX = "\n\n---\n\n";

export function estimatePromptText(text: string): PromptContextTextEstimate {
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    estimatedTokens: estimateTokens(text),
  };
}

export function readCartographerMapMetadata(mapContent: string): CartographerMapMetadata {
  const frontmatterMatch = mapContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatterMatch) {
    return { totalTokens: null };
  }

  for (const line of frontmatterMatch[1].split(/\r?\n/)) {
    const fieldMatch = line.match(/^total_tokens:\s*(.+?)\s*$/);
    if (!fieldMatch) {
      continue;
    }

    const normalized = fieldMatch[1].replace(/["',_]/g, "");
    const totalTokens = Number.parseInt(normalized, 10);
    return { totalTokens: Number.isFinite(totalTokens) ? totalTokens : null };
  }

  return { totalTokens: null };
}

export async function buildPromptContext(
  options: BuildPromptContextOptions,
): Promise<BuiltPromptContext> {
  const taskComponent = buildComponent("task_prompt", "Task prompt", options.taskPrompt);
  const components: PromptContextComponent[] = [];

  let mapContent: string | null = null;
  let mapPath: string | null = null;

  if (options.includeMap) {
    if (options.mapContent !== undefined) {
      mapContent = options.mapContent;
      mapPath = options.mapPath ?? null;
    } else {
      const map = await findCodebaseMap(options.cwd ?? process.cwd());
      mapContent = map?.content ?? null;
      mapPath = map?.path ?? null;
    }
  }

  if (!mapContent) {
    components.push(taskComponent);
    const promptEstimate = estimatePromptText(options.taskPrompt);
    return {
      prompt: options.taskPrompt,
      accounting: {
        ...promptEstimate,
        taskPrompt: estimatePromptText(options.taskPrompt),
        map: {
          included: false,
          path: null,
          bytes: 0,
          estimatedTokens: 0,
          cartographerTotalTokens: null,
        },
        components,
      },
    };
  }

  const mapWrapper = `${MAP_PREFIX}${MAP_SUFFIX}`;
  const mapComponent = buildComponent("codebase_map", "Codebase map", mapContent);
  const wrapperComponent = buildComponent("map_wrapper", "Codebase map wrapper", mapWrapper);
  components.push(wrapperComponent, mapComponent, taskComponent);

  const prompt = `${MAP_PREFIX}${mapContent}${MAP_SUFFIX}${options.taskPrompt}`;
  const promptEstimate = estimatePromptText(prompt);
  const metadata = readCartographerMapMetadata(mapContent);

  return {
    prompt,
    accounting: {
      ...promptEstimate,
      taskPrompt: estimatePromptText(options.taskPrompt),
      map: {
        included: true,
        path: mapPath,
        bytes: mapComponent.bytes,
        estimatedTokens: mapComponent.estimatedTokens,
        cartographerTotalTokens: metadata.totalTokens,
      },
      components,
    },
  };
}

function buildComponent(
  kind: PromptContextComponentKind,
  label: string,
  text: string,
): PromptContextComponent {
  return {
    kind,
    label,
    ...estimatePromptText(text),
  };
}
