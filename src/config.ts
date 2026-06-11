import { existsSync, readFileSync } from "node:fs";

/** SPEC §2.1: the enumerated config keys, as dot paths, with defaults. */
export const CONFIG_DEFAULTS: Record<string, unknown> = {
  "query.weights.fts": 1.0,
  "query.weights.edge": 0.5,
  "query.weights.recency": 0.3,
  "query.hop_decay": 0.5,
  "query.default_limit": 20,
  "suggest.windows": ["same-day", "next-day"],
  "chunk.budget_tokens": 3000,
  "purge.default_days": 30,
  "backup.dest": null, // derived from XDG data home when unset
  "backup.keep": 14,
};

export class ConfigError extends Error {}

export type Config = {
  /** flag > config > default is resolved by callers via get(). */
  get(key: keyof typeof CONFIG_DEFAULTS & string): unknown;
  warnings: string[];
};

/** Strip // and /* *\/ comments and trailing commas; JSONC → JSON. */
function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  // trailing commas (comments already gone, strings must be respected)
  let cleaned = "";
  inString = false;
  for (let j = 0; j < out.length; j++) {
    const c = out[j];
    if (inString) {
      cleaned += c;
      if (c === "\\") cleaned += out[++j] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    if (c === ",") {
      const rest = out.slice(j + 1).match(/^\s*([}\]])/);
      if (rest) continue;
    }
    cleaned += c;
  }
  return cleaned;
}

function flatten(obj: unknown, prefix: string, into: Map<string, unknown>) {
  if (
    obj !== null &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    // arrays and leaf values stop the walk; plain objects recurse
    Object.getPrototypeOf(obj) === Object.prototype
  ) {
    for (const [k, v] of Object.entries(obj)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, into);
    }
  } else {
    into.set(prefix, obj);
  }
}

export function loadConfig(configPath: string | undefined): Config {
  const values = new Map<string, unknown>();
  const warnings: string[] = [];

  if (configPath && existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonc(readFileSync(configPath, "utf8")));
    } catch (e) {
      throw new ConfigError(
        `malformed config at ${configPath}: ${e instanceof Error ? e.message : e}`
      );
    }
    const flat = new Map<string, unknown>();
    flatten(parsed, "", flat);
    for (const [key, value] of flat) {
      if (key in CONFIG_DEFAULTS) values.set(key, value);
      else warnings.push(`warning: unknown config key "${key}"`);
    }
  }

  return {
    get: (key) => (values.has(key) ? values.get(key) : CONFIG_DEFAULTS[key]),
    warnings,
  };
}
