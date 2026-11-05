import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A data-only pg_dump of the local stack, portable across hosts (#259 canary).
//
// The host's pg_dump refuses a server newer than itself (a CI runner's
// postgresql-client is older than the stack's Postgres), so the dump runs
// inside the stack's own database container, whose pg_dump always matches its
// server. The container is supabase_db_<project_id>, from SUPABASE_PROJECT_ID
// or supabase/config.toml, and is used only when it publishes the port
// DATABASE_URL names; otherwise the running supabase_db_* container that does
// is used. A throwaway stack started from a copy under another project id is
// found that way, and a container of some other stack is never dumped. A
// container is considered only when DATABASE_URL names a loopback host: a
// remote database on the same port number is never swapped for a local one.
// With no such container (no docker, a remote host, or a non-container
// Postgres), the host's pg_dump runs against DATABASE_URL. Any failure throws
// with pg_dump's stderr.

const DB_PORT_IN_CONTAINER = '5432';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export type DumpTarget =
  | { kind: 'container'; container: string; user: string; database: string }
  | { kind: 'host'; url: string };

/** The project id of supabase/config.toml, or null. */
export function projectIdFromConfig(text: string): string | null {
  const match = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(text);
  return match ? match[1] : null;
}

/** The host ports a `docker port <container> 5432` answer publishes. */
export function publishedPorts(dockerPortOutput: string): string[] {
  return dockerPortOutput
    .split('\n')
    .map((line) => /:(\d+)\s*$/.exec(line.trim())?.[1])
    .filter((port): port is string => Boolean(port));
}

/**
 * Where the dump runs: for a loopback URL, the named container when it publishes
 * the URL's port, else the first other supabase_db_* container that does; else the host.
 */
export function chooseDumpTarget(
  url: string,
  preferred: string | null,
  containers: Array<{ name: string; ports: string[] }>,
): DumpTarget {
  const parsed = new URL(url);
  const port = parsed.port || '5432';
  const user = decodeURIComponent(parsed.username) || 'postgres';
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'postgres';
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return { kind: 'host', url };
  const publishes = (c: { ports: string[] }) => c.ports.includes(port);
  const named = preferred ? containers.find((c) => c.name === preferred && publishes(c)) : undefined;
  const match = named ?? containers.find((c) => c.name.startsWith('supabase_db_') && publishes(c));
  return match ? { kind: 'container', container: match.name, user, database } : { kind: 'host', url };
}

function run(command: string, args: string[]): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function runningDbContainers(): Array<{ name: string; ports: string[] }> {
  const listed = run('docker', ['ps', '--filter', 'name=supabase_db_', '--format', '{{.Names}}']);
  if (listed.error || listed.status !== 0) return [];
  return listed.stdout
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name, ports: publishedPorts(run('docker', ['port', name, DB_PORT_IN_CONTAINER]).stdout) }));
}

function preferredContainer(): string | null {
  const config = join(process.cwd(), 'supabase', 'config.toml');
  const projectId = process.env.SUPABASE_PROJECT_ID?.trim() || (existsSync(config) ? projectIdFromConfig(readFileSync(config, 'utf8')) : null);
  return projectId ? `supabase_db_${projectId}` : null;
}

/** pg_dump --data-only --no-owner of the database DATABASE_URL names, plus `extra` options. */
export function dumpData(url: string, extra: string[] = []): string {
  const target = chooseDumpTarget(url, preferredContainer(), runningDbContainers());
  const options = ['--data-only', '--no-owner', ...extra];
  const [command, args, where] =
    target.kind === 'container'
      ? ['docker', ['exec', target.container, 'pg_dump', ...options, '-U', target.user, '-d', target.database], `in ${target.container}`]
      : ['pg_dump', [...options, target.url], 'on the host (no running supabase_db_* container serves this URL)'];
  const result = run(command, args);
  if (result.error || result.status !== 0) {
    // stderr is pg_dump's own diagnostics (a version mismatch, a refused connection); it carries no row data.
    const stderr = result.stderr.trim() || result.error?.message || '(no stderr)';
    throw new Error(`pg_dump ${where} exited with status ${String(result.status)}: ${stderr}`);
  }
  return result.stdout;
}
