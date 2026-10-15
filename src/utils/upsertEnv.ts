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
  return {
    env: kept.flatMap((block) => block.lines).join("\n"),
    action: kept.length === blocks.length ? "absent" : "removed",
  };
}
