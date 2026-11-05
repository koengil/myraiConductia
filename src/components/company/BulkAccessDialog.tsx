'use client';

import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { Dialog } from '@/components/overlay';
import {
  BULK_ACCESS_COPY,
  bulkSummary,
  setAccessForMembers,
  type BulkAccessResult,
} from '@/lib/company/bulkAccess';
import type { CompanyPermission } from '@/lib/constants/companyPermissions';
import { AccessChoiceFields, choiceOutsideEnvelope } from './AccessChoiceFields';
import type {
  CompanyMemberAccess,
  CompanyPermissionDefinition,
  CompanyRoleSummary,
} from './companyAccessUi';

export type BulkAccessPerson = {
  id: string;
  name: string;
  access?: CompanyMemberAccess;
};

function shared<T>(lists: T[][]): Set<T> {
  if (lists.length === 0) return new Set();
  return new Set(lists[0].filter((item) => lists.every((list) => list.includes(item))));
}

function namesLine(people: readonly BulkAccessPerson[]): string {
  const names = people.map((person) => person.name);
  if (names.length <= 4) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

const STATUS_TEXT: Record<BulkAccessResult['status'], string> = {
  updated: 'Access set',
  stale: BULK_ACCESS_COPY.stale,
  stale_unread: BULK_ACCESS_COPY.staleUnread,
  failed: '',
};

/**
 * "Set access" for the people selected on the roster: one choice of roles and
 * permissions, written person by person through the existing access endpoint
 * (no bulk API). The result lists every person; anyone whose access changed
 * underneath is reloaded and can be tried again from the latest version. If
 * that reload fails, the row says so and is not retried with the old version.
 * Anyone whose current access could not be read is flagged and left out of
 * the write: their version is unknown.
 */
export function BulkAccessDialog({
  open,
  onClose,
  companyId,
  people,
  roles,
  permissions,
  viewerPermissionKeys,
  onAccessChange,
  onFinished,
}: {
  open: boolean;
  onClose: () => void;
  /** "Done" after a run: the roster clears its selection. */
  onFinished?: () => void;
  companyId: string;
  people: readonly BulkAccessPerson[];
  roles: readonly CompanyRoleSummary[];
  permissions: readonly CompanyPermissionDefinition[];
  viewerPermissionKeys: ReadonlySet<CompanyPermission>;
  onAccessChange: (access: CompanyMemberAccess) => void;
}) {
  // Only people whose current access was read are written: without it there
  // is no version to write against.
  const readable = people.filter((person) => person.access);
  const unread = people.filter((person) => !person.access);
  // Start from what every selected person already has in common. The roster
  // remounts this dialog (a new key) for each "Set access", so this is fresh.
  const [selectedRoles, setSelectedRoles] = React.useState<Set<string>>(() =>
    shared(readable.map((person) => person.access?.assigned_roles.map((role) => role.id) ?? [])),
  );
  const [selectedDirect, setSelectedDirect] = React.useState<Set<CompanyPermission>>(() =>
    shared(readable.map((person) => person.access?.direct_permissions ?? [])),
  );
  const [running, setRunning] = React.useState(false);
  const [results, setResults] = React.useState<BulkAccessResult[] | null>(null);
  // The latest version seen per person: a reloaded copy after a refused write.
  const [versions] = React.useState(
    () => new Map(people.map((person) => [person.id, person.access?.version ?? 0])),
  );

  const outside = choiceOutsideEnvelope(roles, selectedRoles, selectedDirect, viewerPermissionKeys);
  // A row whose latest access could not be loaded is not retryable: it would
  // send the version that was just refused.
  const retryable = (results ?? []).filter(
    (result) => result.status === 'stale' || result.status === 'failed',
  );
  const count = people.length;
  const peopleWord = count === 1 ? 'person' : 'people';
  const writeCount = readable.length;
  const writeWord = writeCount === 1 ? 'person' : 'people';

  async function run(targets: readonly BulkAccessPerson[]) {
    setRunning(true);
    const next = await setAccessForMembers(
      companyId,
      targets.map((person) => ({
        userId: person.id,
        name: person.name,
        version: versions.get(person.id) ?? 0,
      })),
      { roleIds: [...selectedRoles], directPermissions: [...selectedDirect] },
    );
    for (const result of next) {
      if (result.status !== 'updated' && result.status !== 'stale') continue;
      versions.set(result.userId, result.access.version);
      onAccessChange(result.access);
    }
    // A retry replaces only the rows it ran; the rest keep their result.
    setResults((current) => {
      if (!current) return next;
      const byId = new Map(next.map((result) => [result.userId, result]));
      return current.map((result) => byId.get(result.userId) ?? result);
    });
    setRunning(false);
  }

  const footer = results ? (
    <>
      {retryable.length > 0 ? (
        <Button
          variant="secondary"
          disabled={running || outside}
          onClick={() =>
            void run(people.filter((person) => retryable.some((result) => result.userId === person.id)))
          }
        >
          Try again for {retryable.length}
        </Button>
      ) : null}
      <Button
        disabled={running}
        onClick={() => {
          onFinished?.();
          onClose();
        }}
      >
        Done
      </Button>
    </>
  ) : (
    <>
      <Button variant="secondary" disabled={running} onClick={onClose}>
        Cancel
      </Button>
      <Button disabled={running || outside || writeCount === 0} onClick={() => void run(readable)}>
        {running ? 'Setting access' : `Set access for ${writeCount} ${writeWord}`}
      </Button>
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!running) onClose();
      }}
      title={`Set access for ${count} ${peopleWord}`}
      description="Pick the roles and permissions they should all have. This replaces what each of them has now."
      size="lg"
      dismissOnScrim={false}
      footer={footer}
    >
      <div className="flex flex-col gap-[var(--space-4)]">
        <p className="text-[length:var(--text-sm)] text-[var(--ink)]">{namesLine(people)}</p>
        {unread.length > 0 && !results ? (
          <ul aria-label="Not included" className="flex flex-col gap-[2px]">
            {unread.map((person) => (
              <li
                key={person.id}
                data-unread=""
                className="text-[length:var(--text-xs)] text-[var(--negative)]"
              >
                <span className="font-medium">{person.name}</span>
                {' · '}
                <span>{BULK_ACCESS_COPY.unread}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {results ? (
          <section aria-label="Results" className="flex flex-col gap-[var(--space-2)]">
            <p role="status" className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
              {bulkSummary(results)}
            </p>
            <ul className="flex flex-col divide-y divide-[var(--stroke)] rounded-[var(--radius-card)] border border-[var(--stroke)]">
              {results.map((result) => (
                <li
                  key={result.userId}
                  data-result={result.status}
                  className="flex flex-col gap-[2px] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] sm:flex-row sm:items-baseline sm:justify-between sm:gap-[var(--space-3)]"
                >
                  <span className="font-medium text-[var(--ink)]">{result.name}</span>
                  <span
                    className={
                      result.status === 'updated'
                        ? 'text-[length:var(--text-xs)] text-[var(--ink-secondary)]'
                        : 'text-[length:var(--text-xs)] text-[var(--negative)]'
                    }
                  >
                    {result.status === 'failed' ? result.message : STATUS_TEXT[result.status]}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <>
            <AccessChoiceFields
              roles={roles}
              permissions={permissions}
              viewerPermissionKeys={viewerPermissionKeys}
              selectedRoles={selectedRoles}
              selectedDirect={selectedDirect}
              disabled={running}
              onRolesChange={setSelectedRoles}
              onDirectChange={setSelectedDirect}
            />
            {outside ? (
              <p role="status" className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                Take away the items you can&apos;t give before setting access.
              </p>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}
