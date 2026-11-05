// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, it } from 'vitest';

/**
 * openapi/phase1.json names every /api/v1 route handler's methods, and nothing
 * the handlers do not export. Entries marked x-incomplete carry a summary and
 * auth note only; their shapes live in docs/03-engineering/api-v1.md and the
 * handler.
 */

const ROOT = join(process.cwd(), 'src/app/api/v1');
const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === 'route.ts' ? [path] : [];
  });
}

const norm = (path: string) => path.replace(/\{[^}]+\}/g, '{}');

function handlerOperations(): string[] {
  return routeFiles(ROOT).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const dir = relative(ROOT, file).split(sep).slice(0, -1).join('/');
    const path = norm(`/${dir}`.replace(/\[([^\]]+)\]/g, '{$1}'));
    return METHODS.filter((method) =>
      new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${method}\\b|export\\s*\\{[^}]*\\b${method}\\b`).test(source),
    ).map((method) => `${method} ${path === '/' ? '/' : path}`);
  });
}

function specOperations(): string[] {
  const spec = JSON.parse(readFileSync(join(process.cwd(), 'openapi/phase1.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  return Object.entries(spec.paths).flatMap(([path, ops]) =>
    Object.keys(ops)
      .filter((key) => (METHODS as readonly string[]).includes(key.toUpperCase()))
      .map((key) => `${key.toUpperCase()} ${norm(path)}`),
  );
}

it('documents every exported handler method of /api/v1 in openapi/phase1.json, and only those', () => {
  expect(specOperations().sort()).toEqual(handlerOperations().sort());
});

it('lists the access-request destinations the TS constants mirror', async () => {
  const { ACCESS_DESTINATIONS } = await import('@/lib/constants/accessRequests');
  const spec = JSON.parse(readFileSync(join(process.cwd(), 'openapi/phase1.json'), 'utf8')) as {
    components: { schemas: Record<string, { enum?: string[] }> };
  };
  expect(spec.components.schemas.AccessDestination?.enum).toEqual(ACCESS_DESTINATIONS);
});
