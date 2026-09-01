import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname);

/** Strip comments so example code in JSDoc doesn't count as a real import. */
function code(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'testkit') continue;
      out.push(...sourceFiles(full));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.spec.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

const FORBIDDEN = [
  '@nestjs/',
  '@prisma/',
  'prisma',
  '@river/shared-types',
  'react',
  'react-native',
  'react-dom',
  'socket.io',
  'socket.io-client',
  'express',
  'ioredis',
  'fastify',
  '@tanstack/',
  'zustand',
  'zod',
];

describe('poker engine isolation', () => {
  it('declares zero runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('never imports a framework, database, transport, or UI module', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const content = code(readFileSync(file, 'utf8'));
      const importPaths = [...content.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g)].map(
        (m) => m[1] as string,
      );
      for (const path of importPaths) {
        if (FORBIDDEN.some((bad) => path === bad || path.startsWith(bad))) {
          offenders.push(`${file.replace(SRC, 'src')} -> ${path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only pulls in Node built-ins and relative paths', () => {
    const allowedBareImports = new Set(['node:crypto', 'node:fs', 'node:path']);
    const unexpected: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const content = code(readFileSync(file, 'utf8'));
      for (const match of content.matchAll(/from\s+['"]([^'".][^'"]*)['"]/g)) {
        const spec = match[1] as string;
        if (!spec.startsWith('.') && !allowedBareImports.has(spec)) {
          unexpected.push(`${file.replace(SRC, 'src')} -> ${spec}`);
        }
      }
    }
    expect(unexpected).toEqual([]);
  });
});
