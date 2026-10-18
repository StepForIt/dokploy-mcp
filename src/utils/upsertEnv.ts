import { type AnnotationTag, formatAnnotation, parseAnnotation } from "./envAnnotations.js";

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const ENV_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

export type UpsertAction = "created" | "updated" | "unchanged";

export interface UpsertResult {
  env: string;
  action: UpsertAction;
}

// A quoted value opened on this line but not closed on it spans the following lines
// (PEM keys, JSON blobs): they belong to the same variable.
function openQuote(value: string): string | null {
  const trimmed = value.trimStart();
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") return null;
  return closesQuote(trimmed.slice(1), quote) ? null : quote;
}

function closesQuote(text: string, quote: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && quote === '"') {
      i++;
    } else if (text[i] === quote) {
      return true;
    }
  }
  return false;
}

interface EnvBlock {
  /** Variable name, absent for comments, blank or unparsable lines. */
  name?: string;
  prefix: string;
  lines: string[];
}

// Splits an env into one block per variable (a multi-line quoted value stays in its block) and
// one block per other line, so rewriting a block never touches its neighbours.
function splitEnvBlocks(env: string | null | undefined): EnvBlock[] {
  const lines = env ? env.split("\n") : [];
  const blocks: EnvBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(ENV_LINE);
    if (!m) {
      blocks.push({ prefix: "", lines: [line] });
      continue;
    }
    const [, prefix = "", name = "", current = ""] = m;
    const block = [line];
    const quote = openQuote(current);
    if (quote) {
      while (i + 1 < lines.length) {
        i++;
        block.push(lines[i] ?? "");
        if (closesQuote(lines[i] ?? "", quote)) break;
      }
    }
    blocks.push({ name, prefix, lines: block });
  }
  return blocks;
}

/**
 * Sets one variable in a dotenv-style string, leaving every other line untouched (comments,
 * order, other values). The first definition of `key` is rewritten in place, later duplicates
 * are dropped so the new value is the only one Dokploy sees; an unknown key is appended.
 */
export function upsertEnvVar(
  env: string | null | undefined,
  key: string,
  value: string,
): UpsertResult {
  const out: string[] = [];
  let found = false;
  let changed = false;

  for (const block of splitEnvBlocks(env)) {
    if (block.name !== key) {
      out.push(...block.lines);
      continue;
    }
    if (found) {
      changed = true;
      continue;
    }
    found = true;
    const next = `${block.prefix}${key}=${value}`;
    if (block.lines.join("\n") !== next) changed = true;
    out.push(next);
  }

  if (!found) {
    while (out.length > 0 && out[out.length - 1]?.trim() === "") out.pop();
    out.push(`${key}=${value}`);
    return { env: out.join("\n"), action: "created" };
  }

  return { env: out.join("\n"), action: changed ? "updated" : "unchanged" };
}

export interface UnsetResult {
  env: string;
  action: "removed" | "absent";
}

/** Removes every definition of `key` (multi-line values included), keeping all other lines. */
export function unsetEnvVar(env: string | null | undefined, key: string): UnsetResult {
  const blocks = splitEnvBlocks(env);
  const kept = blocks.filter((block) => block.name !== key);
  const removed = kept.length !== blocks.length;
  // Its normed comments (expiry, provenance) would only mislead once the variable is gone.
  const clean = kept.filter((block) => !isAnnotationOf(block, key));
  return {
    env: clean.flatMap((block) => block.lines).join("\n"),
    action: removed ? "removed" : "absent",
  };
}

function isAnnotationOf(block: EnvBlock, key: string, tag?: AnnotationTag): boolean {
  if (block.name !== undefined || block.lines.length !== 1) return false;
  const annotation = parseAnnotation(block.lines[0] ?? "");
  return annotation?.key === key && (tag === undefined || annotation.tag === tag);
}

export interface EnvVar {
  name: string;
  /** Everything after `NAME=`, quotes and extra lines of a multi-line value included. */
  raw: string;
}

/** The variables of an env, first definition of each name (the one the upsert rewrites). */
export function readEnvVars(env: string | null | undefined): EnvVar[] {
  const seen = new Set<string>();
  const vars: EnvVar[] = [];
  for (const block of splitEnvBlocks(env)) {
    if (block.name === undefined || seen.has(block.name)) continue;
    seen.add(block.name);
    const [first = "", ...rest] = block.lines;
    const raw = first.slice(first.indexOf("=") + 1);
    vars.push({ name: block.name, raw: [raw, ...rest].join("\n") });
  }
  return vars;
}

export type Annotations = Partial<Record<AnnotationTag, string>>;

/** Normed comments per variable name (first one of each tag wins). */
export function readAnnotations(env: string | null | undefined): Map<string, Annotations> {
  const result = new Map<string, Annotations>();
  for (const block of splitEnvBlocks(env)) {
    const annotation = block.name === undefined ? parseAnnotation(block.lines[0] ?? "") : null;
    if (!annotation) continue;
    const entry = result.get(annotation.key) ?? {};
    entry[annotation.tag] ??= annotation.value;
    result.set(annotation.key, entry);
  }
  return result;
}

export interface AnnotationResult {
  env: string;
  action: "set" | "removed" | "unchanged";
}

/**
 * Writes (or with `null` removes) the normed comment `tag` of `key`. An existing one is
 * rewritten where it stands, otherwise it goes right above the variable. The variable itself and
 * every other line are untouched.
 */
export function setEnvAnnotation(
  env: string | null | undefined,
  key: string,
  tag: AnnotationTag,
  value: string | null,
): AnnotationResult {
  const blocks = splitEnvBlocks(env);
  if (value !== null && !blocks.some((b) => b.name === key)) {
    throw new Error(`Variable ${key} not found; nothing was changed`);
  }
  const line = value === null ? null : formatAnnotation(key, tag, value);
  const out: string[] = [];
  let written = false;
  let changed = false;

  for (const block of blocks) {
    if (isAnnotationOf(block, key, tag)) {
      if (line !== null && !written) {
        written = true;
        if (block.lines[0] !== line) changed = true;
        out.push(line);
      } else {
        changed = true;
      }
      continue;
    }
    if (block.name === key && line !== null && !written) {
      written = true;
      changed = true;
      out.push(line);
    }
    out.push(...block.lines);
  }

  const action = !changed ? "unchanged" : line === null ? "removed" : "set";
  return { env: out.join("\n"), action };
}

/** The value a line stands for: surrounding matching quotes of a one-line value are dropped. */
export function unquoteEnvValue(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  const quoted = (quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote);
  return quoted && !value.includes("\n") ? value.slice(1, -1) : value;
}
