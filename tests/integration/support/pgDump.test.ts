import { describe, expect, it } from 'vitest';

import { chooseDumpTarget, projectIdFromConfig, publishedPorts } from './pgDump';

const URL_LOCAL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

describe('where the canary dump runs', () => {
  it('reads the project id from supabase/config.toml', () => {
    expect(projectIdFromConfig('# Supabase\nproject_id = "conductia"\n[api]\nport = 54321\n')).toBe('conductia');
    expect(projectIdFromConfig('[api]\nport = 54321\n')).toBeNull();
  });

  it('reads the host ports docker publishes for 5432', () => {
    expect(publishedPorts('0.0.0.0:54322\n[::]:54322\n')).toEqual(['54322', '54322']);
    expect(publishedPorts('')).toEqual([]);
  });

  it("uses the project's container when it publishes the URL's port", () => {
    const target = chooseDumpTarget(URL_LOCAL, 'supabase_db_conductia', [
      { name: 'supabase_db_other', ports: ['54322'] },
      { name: 'supabase_db_conductia', ports: ['54322'] },
    ]);
    expect(target).toEqual({ kind: 'container', container: 'supabase_db_conductia', user: 'postgres', database: 'postgres' });
  });

  it("never dumps the project's container when it serves another port: it finds the one that serves the URL", () => {
    const target = chooseDumpTarget('postgresql://postgres:postgres@127.0.0.1:59622/postgres', 'supabase_db_conductia', [
      { name: 'supabase_db_conductia', ports: ['54322'] },
      { name: 'supabase_db_throwaway', ports: ['59622'] },
    ]);
    expect(target).toMatchObject({ kind: 'container', container: 'supabase_db_throwaway' });
  });

  it('never swaps a remote database for a local container that publishes the same port', () => {
    const remote = 'postgresql://postgres:secret@db.example.com:54322/postgres';
    expect(chooseDumpTarget(remote, 'supabase_db_conductia', [{ name: 'supabase_db_conductia', ports: ['54322'] }])).toEqual({
      kind: 'host',
      url: remote,
    });
  });

  it('treats localhost and IPv6 loopback as local', () => {
    const containers = [{ name: 'supabase_db_conductia', ports: ['54322'] }];
    expect(chooseDumpTarget('postgresql://postgres@localhost:54322/postgres', null, containers)).toMatchObject({ kind: 'container' });
    expect(chooseDumpTarget('postgresql://postgres@[::1]:54322/postgres', null, containers)).toMatchObject({ kind: 'container' });
  });

  it('falls back to the host pg_dump when no container serves the URL', () => {
    expect(chooseDumpTarget(URL_LOCAL, 'supabase_db_conductia', [])).toEqual({ kind: 'host', url: URL_LOCAL });
    expect(chooseDumpTarget(URL_LOCAL, null, [{ name: 'supabase_db_x', ports: ['55322'] }])).toEqual({ kind: 'host', url: URL_LOCAL });
  });
});
