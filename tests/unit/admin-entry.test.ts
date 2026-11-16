import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('keeps administrator code and API checks out of the entire public import graph', () => {
  const visited = new Set<string>();
  function walk(file: string): void {
    if (visited.has(file) || file.endsWith('.css')) return;
    visited.add(file);
    expect(file.replaceAll('\\', '/')).not.toContain('/src/admin/');
    const source = readFileSync(file, 'utf8');
    expect(source).not.toContain('/api/admin');
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g);
    for (const match of imports) {
      const target = match[1]!;
      if (!target.startsWith('.')) continue;
      let path = resolve(dirname(file), target);
      if (!existsSync(path)) path += '.ts';
      walk(path);
    }
  }
  walk(resolve('src/main.ts'));
  expect(visited.size).toBeGreaterThan(5);
});
