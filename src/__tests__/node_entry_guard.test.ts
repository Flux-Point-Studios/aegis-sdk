// The main entry stays free of Node: every source that imports a Node module sits under
// src/node, which only the ./node entry exports.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

describe('the main entry', () => {
  it('imports no Node module outside src/node', () => {
    const all = sources(SRC).map((p) => relative(SRC, p).split(sep).join('/'));
    expect(all.filter((p) => p.startsWith('node/')).length).toBeGreaterThan(0);
    const reaching = all.filter((p) => !p.startsWith('node/') &&
      /(from |require\()'(node:|fs'|path'|os'|child_process')/.test(readFileSync(join(SRC, p), 'utf8')));
    expect(reaching).toEqual([]);
  });

  it('never imports src/node', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(index).not.toMatch(/\.\/node/);
  });
});
