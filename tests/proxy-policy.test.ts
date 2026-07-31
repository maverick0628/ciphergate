import { describe, it, expect } from 'vitest';
import {
  parseServerPolicy,
  compilePolicy,
  filterTools,
  evaluateToolCall,
  redactText,
  redactResult,
  REDACTION_MARKER,
} from '../src/proxy/policy.js';

describe('parseServerPolicy', () => {
  it('returns empty policy for undefined', () => {
    expect(parseServerPolicy(undefined, 'x')).toEqual({});
  });
  it('accepts a valid policy', () => {
    const p = parseServerPolicy({ allowTools: ['a'], denyArgPatterns: ['foo'], redactPatterns: ['bar'] }, 'x');
    expect(p.allowTools).toEqual(['a']);
  });
  it('rejects non-object policy', () => {
    expect(() => parseServerPolicy(['a'], 'srv')).toThrow(/policy must be an object/);
  });
  it('rejects non-string-array fields', () => {
    expect(() => parseServerPolicy({ allowTools: [1] }, 'srv')).toThrow(/allowTools must be a string array/);
  });
  it('rejects a bad regex at parse time', () => {
    expect(() => parseServerPolicy({ denyArgPatterns: ['('] }, 'srv')).toThrow(/Invalid policy regex/);
  });
  it('rejects non-boolean disableDefaults', () => {
    expect(() => parseServerPolicy({ disableDefaults: 'yes' }, 'srv')).toThrow(/disableDefaults must be a boolean/);
  });
});

describe('filterTools', () => {
  const tools = [{ name: 'read' }, { name: 'write' }, { name: 'delete' }];
  it('passes all tools through when no allowlist', () => {
    expect(filterTools(tools, compilePolicy({}))).toHaveLength(3);
  });
  it('keeps only allowlisted tools', () => {
    const out = filterTools(tools, compilePolicy({ allowTools: ['read', 'write'] }));
    expect(out.map((t) => t.name)).toEqual(['read', 'write']);
  });
});

describe('evaluateToolCall — allowlist', () => {
  it('denies tools not on the allowlist', () => {
    const d = evaluateToolCall('delete', {}, compilePolicy({ allowTools: ['read'] }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/not in the allowlist/);
  });
  it('allows tools on the allowlist', () => {
    expect(evaluateToolCall('read', {}, compilePolicy({ allowTools: ['read'] })).allowed).toBe(true);
  });
});

describe('evaluateToolCall — default deny patterns', () => {
  const policy = compilePolicy({});
  it('blocks path traversal in arguments', () => {
    const d = evaluateToolCall('read', { path: '../../etc/passwd' }, policy);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/deny pattern/);
  });
  it('blocks /etc/shadow access', () => {
    expect(evaluateToolCall('read', { file: '/etc/shadow' }, policy).allowed).toBe(false);
  });
  it('allows a benign call', () => {
    expect(evaluateToolCall('read', { path: 'notes/today.md' }, policy).allowed).toBe(true);
  });
  it('can be disabled with disableDefaults', () => {
    const d = evaluateToolCall('read', { path: '../secret' }, compilePolicy({ disableDefaults: true }));
    expect(d.allowed).toBe(true);
  });
});

describe('evaluateToolCall — warn patterns', () => {
  it('warns (but allows) on credential-shaped args by default', () => {
    const d = evaluateToolCall('store', { text: 'api_key: sk-live-123' }, compilePolicy({}));
    expect(d.allowed).toBe(true);
    expect(d.warnings.length).toBeGreaterThan(0);
  });
  it('supports custom deny patterns merged with defaults', () => {
    const d = evaluateToolCall('run', { cmd: 'rm -rf /' }, compilePolicy({ denyArgPatterns: ['rm\\s+-rf'] }));
    expect(d.allowed).toBe(false);
  });
});

describe('redactText / redactResult', () => {
  it('redacts matches in text', () => {
    const policy = compilePolicy({ redactPatterns: ['sk-[a-z0-9]+'] });
    expect(redactText('token=sk-abc123 end', policy)).toBe(`token=${REDACTION_MARKER} end`);
  });
  it('redacts text content items in a tool result, leaving non-text untouched', () => {
    const policy = compilePolicy({ redactPatterns: ['SECRET'] });
    const result = {
      content: [
        { type: 'text', text: 'here is a SECRET value' },
        { type: 'image', data: 'SECRET-but-not-text' },
      ],
    };
    const out = redactResult(result, policy);
    expect((out.content[0] as { text: string }).text).toBe(`here is a ${REDACTION_MARKER} value`);
    expect((out.content[1] as { data: string }).data).toBe('SECRET-but-not-text');
  });
  it('is a no-op when no redact patterns', () => {
    const result = { content: [{ type: 'text', text: 'unchanged' }] };
    expect(redactResult(result, compilePolicy({}))).toBe(result);
  });
  it('redacts regardless of key order in args (stable stringify)', () => {
    const policy = compilePolicy({ denyArgPatterns: ['"b":2.*"a":1'] });
    // keys are sorted before matching, so a/b order in the object does not matter
    const d = evaluateToolCall('x', { b: 2, a: 1 }, policy);
    expect(d.allowed).toBe(true); // sorted form is {"a":1,"b":2}, pattern won't match
  });
});
