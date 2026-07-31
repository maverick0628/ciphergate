import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isDirectInvocation } from '../src/cli.js';

describe('isDirectInvocation (npm-link entry-point guard)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sg-entry-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns true when argv1 is the module file itself', () => {
    const realFile = join(dir, 'cli.js');
    writeFileSync(realFile, '// fake cli\n');
    const moduleUrl = pathToFileURL(realFile).href;

    expect(isDirectInvocation(realFile, moduleUrl)).toBe(true);
  });

  it('returns true when argv1 is a symlink to the module file (npm link case)', () => {
    const realFile = join(dir, 'cli.js');
    writeFileSync(realFile, '// fake cli\n');
    const symlinkPath = join(dir, 'gateway'); // mimics ../bin/gateway shim name
    symlinkSync(realFile, symlinkPath);
    const moduleUrl = pathToFileURL(realFile).href;

    expect(isDirectInvocation(symlinkPath, moduleUrl)).toBe(true);
  });

  it('returns false when argv1 is an unrelated file', () => {
    const realFile = join(dir, 'cli.js');
    writeFileSync(realFile, '// fake cli\n');
    const otherFile = join(dir, 'other.js');
    writeFileSync(otherFile, '// other\n');
    const moduleUrl = pathToFileURL(realFile).href;

    expect(isDirectInvocation(otherFile, moduleUrl)).toBe(false);
  });

  it('returns false when argv1 is undefined', () => {
    const realFile = join(dir, 'cli.js');
    writeFileSync(realFile, '// fake cli\n');
    const moduleUrl = pathToFileURL(realFile).href;

    expect(isDirectInvocation(undefined, moduleUrl)).toBe(false);
  });

  it('returns false when argv1 path does not exist', () => {
    const realFile = join(dir, 'cli.js');
    writeFileSync(realFile, '// fake cli\n');
    const moduleUrl = pathToFileURL(realFile).href;

    expect(isDirectInvocation('/nonexistent/path', moduleUrl)).toBe(false);
  });
});
