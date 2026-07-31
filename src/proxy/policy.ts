/**
 * Per-server guard policy for the MCP guard bridge (`gateway-proxy guard`).
 *
 * Where the scoped-injector (`gateway-proxy run`) brokers *credentials*, the
 * guard sits in the JSON-RPC stream and brokers *behaviour*: it can hide tools
 * not on an allowlist, block tool calls whose arguments match dangerous
 * patterns (e.g. path traversal), warn on credential-shaped arguments, and
 * redact secrets from responses. This is the rest of the homelab-agent
 * scoped-mcp model.
 *
 * All matching here is on the raw (untrusted) tool name / argument / result
 * text, so the functions are pure and exhaustively unit-tested.
 */

/** Raw policy as written in the manifest (all optional, all backward compatible). */
export interface ServerPolicy {
  /** If set, ONLY these tool names are exposed/callable; everything else is hidden + denied. */
  allowTools?: string[];
  /** Regexes; if any matches the stringified call arguments, the call is BLOCKED. */
  denyArgPatterns?: string[];
  /** Regexes; if any matches the stringified call arguments, the call is allowed but a WARNING is logged. */
  warnArgPatterns?: string[];
  /** Regexes; matches in text results are replaced with the redaction marker. */
  redactPatterns?: string[];
  /** Opt out of the built-in default deny/warn patterns (default: false → defaults applied). */
  disableDefaults?: boolean;
}

/** Path traversal and obvious sensitive-path access — blocked by default. */
export const DEFAULT_DENY_ARG_PATTERNS: string[] = [
  '\\.\\.[/\\\\]', // ../ or ..\
  '(?:^|[^A-Za-z0-9])/etc/(?:passwd|shadow)\\b',
  '\\bid_rsa\\b',
];

/** Credential-shaped arguments — allowed but flagged, since an agent passing a raw secret is suspicious. */
export const DEFAULT_WARN_ARG_PATTERNS: string[] = [
  '(?i)\\b(?:api[_-]?key|password|passwd|secret|bearer|access[_-]?token)\\b\\s*[=:]',
];

export const REDACTION_MARKER = '[REDACTED]';

export interface CompiledPolicy {
  allowTools: Set<string> | null;
  denyArg: RegExp[];
  warnArg: RegExp[];
  redact: RegExp[];
}

function compileAll(patterns: string[]): RegExp[] {
  return patterns.map((p) => {
    // Support an inline (?i) case-insensitive flag at the start of a pattern.
    let flags = 'g';
    let body = p;
    const ci = /^\(\?i\)/.exec(p);
    if (ci) {
      flags += 'i';
      body = p.slice(ci[0].length);
    }
    try {
      return new RegExp(body, flags);
    } catch (err) {
      throw new Error(`Invalid policy regex ${JSON.stringify(p)}: ${(err as Error).message}`);
    }
  });
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Validate a raw policy object from a manifest. Throws on structural / regex errors. */
export function parseServerPolicy(raw: unknown, label: string): ServerPolicy {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid manifest: ${label}.policy must be an object`);
  }
  const p = raw as Record<string, unknown>;
  for (const key of ['allowTools', 'denyArgPatterns', 'warnArgPatterns', 'redactPatterns'] as const) {
    if (p[key] !== undefined && !isStringArray(p[key])) {
      throw new Error(`Invalid manifest: ${label}.policy.${key} must be a string array`);
    }
  }
  if (p.disableDefaults !== undefined && typeof p.disableDefaults !== 'boolean') {
    throw new Error(`Invalid manifest: ${label}.policy.disableDefaults must be a boolean`);
  }
  const policy: ServerPolicy = {
    allowTools: p.allowTools as string[] | undefined,
    denyArgPatterns: p.denyArgPatterns as string[] | undefined,
    warnArgPatterns: p.warnArgPatterns as string[] | undefined,
    redactPatterns: p.redactPatterns as string[] | undefined,
    disableDefaults: p.disableDefaults as boolean | undefined,
  };
  // Compile eagerly so bad regexes fail at load time, not mid-session.
  compilePolicy(policy);
  return policy;
}

/** Compile a policy into ready-to-use matchers, merging built-in defaults unless disabled. */
export function compilePolicy(policy: ServerPolicy): CompiledPolicy {
  const useDefaults = !policy.disableDefaults;
  const denyPatterns = [...(useDefaults ? DEFAULT_DENY_ARG_PATTERNS : []), ...(policy.denyArgPatterns ?? [])];
  const warnPatterns = [...(useDefaults ? DEFAULT_WARN_ARG_PATTERNS : []), ...(policy.warnArgPatterns ?? [])];
  return {
    allowTools: policy.allowTools ? new Set(policy.allowTools) : null,
    denyArg: compileAll(denyPatterns),
    warnArg: compileAll(warnPatterns),
    redact: compileAll(policy.redactPatterns ?? []),
  };
}

/** Filter a tools/list result down to the allowlist (no-op when no allowlist). */
export function filterTools<T extends { name: string }>(tools: T[], policy: CompiledPolicy): T[] {
  if (!policy.allowTools) return tools;
  return tools.filter((t) => policy.allowTools!.has(t.name));
}

export interface ToolCallDecision {
  allowed: boolean;
  reason?: string;
  warnings: string[];
}

/** Decide whether a tool call may proceed, and collect any warnings. */
export function evaluateToolCall(name: string, args: unknown, policy: CompiledPolicy): ToolCallDecision {
  if (policy.allowTools && !policy.allowTools.has(name)) {
    return { allowed: false, reason: `tool "${name}" is not in the allowlist`, warnings: [] };
  }
  const argStr = stableStringify(args);
  for (const re of policy.denyArg) {
    re.lastIndex = 0;
    if (re.test(argStr)) {
      return { allowed: false, reason: `argument matched deny pattern ${re.source}`, warnings: [] };
    }
  }
  const warnings: string[] = [];
  for (const re of policy.warnArg) {
    re.lastIndex = 0;
    if (re.test(argStr)) warnings.push(`argument matched warn pattern ${re.source}`);
  }
  return { allowed: true, warnings };
}

/** Redact all redact-pattern matches in a string. */
export function redactText(text: string, policy: CompiledPolicy): string {
  let out = text;
  for (const re of policy.redact) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTION_MARKER);
  }
  return out;
}

/**
 * Redact text content items in an MCP CallTool result in place-safe fashion.
 * Returns a new result object; non-text content is passed through untouched.
 */
export function redactResult<T extends { content?: Array<Record<string, unknown>> }>(result: T, policy: CompiledPolicy): T {
  if (policy.redact.length === 0 || !Array.isArray(result.content)) return result;
  const content = result.content.map((item) => {
    if (item && item.type === 'text' && typeof item.text === 'string') {
      return { ...item, text: redactText(item.text, policy) };
    }
    return item;
  });
  return { ...result, content };
}

/** Deterministic stringify so pattern matching is stable regardless of key order. */
function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.keys(v).sort().reduce((acc, k) => { (acc as Record<string, unknown>)[k] = (v as Record<string, unknown>)[k]; return acc; }, {} as Record<string, unknown>)
        : v,
    ) ?? '';
  } catch {
    return String(value);
  }
}
