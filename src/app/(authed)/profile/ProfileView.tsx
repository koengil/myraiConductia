'use client';

import * as React from 'react';
import { Camera, Pencil } from 'lucide-react';

import { PreviewChip } from '@/components/overlay';
import { initialsFor, useCurrentUser } from '@/lib/auth/useCurrentUser';
import { useProfilePhoto } from '@/lib/auth/useProfilePhoto';
import { useSignOut } from '@/lib/auth/useSignOut';
import {
  PROFILE_DISPLAY_NAME_MAX_LENGTH,
  PROFILE_FULL_NAME_MAX_LENGTH,
  checkProfileDisplayName,
  checkProfileFullName,
} from '@/lib/validation/inputPolicy';

import { ConnectResult } from './ConnectResult';
import { ProfileRoleField } from './ProfileRoleField';
import { useProfileTitlePreview } from './profileTitlePreview';

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

/** The browser refused to keep the photo (its storage is full). */
export const PHOTO_NOT_KEPT = 'This photo could not be kept in this browser. Try a smaller one.';

/** A Preview field is kept in this browser, never saved: its button says so. */
export const PREVIEW_KEEP_LABEL = 'Keep in this browser';

const ROW_CLASS =
  'grid gap-(--space-1) border-b border-[var(--stroke)] py-(--space-3) last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center sm:gap-(--space-4)';
const LABEL_CLASS = 'text-(length:--text-sm) font-medium text-ink-secondary';
const INPUT_CLASS =
  'h-9 min-w-0 flex-1 rounded-input border border-transparent bg-[var(--surface-subtle)] px-(--space-3) text-(length:--text-sm) text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent';
const ICON_BUTTON_CLASS =
  'inline-flex size-9 shrink-0 items-center justify-center rounded-button text-ink-tertiary transition-colors hover:bg-[var(--surface-subtle)] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const PRIMARY_BUTTON_CLASS =
  'inline-flex h-9 items-center justify-center rounded-button bg-[var(--accent)] px-(--space-4) text-(length:--text-sm) font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-dark)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent';
const GHOST_BUTTON_CLASS =
  'inline-flex h-9 items-center justify-center rounded-button px-(--space-3) text-(length:--text-sm) font-medium text-ink-secondary transition-colors hover:bg-[var(--surface-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/**
 * One profile value with a pencil: read as text, edit in place. Enter saves,
 * Escape cancels; focus returns to the pencil either way. `onSave` resolves to
 * an error message, or null when the value is saved.
 */
function EditableField({
  id,
  label,
  value,
  maxLength,
  autoComplete,
  emptyText = 'Not set',
  preview = false,
  onReset,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  maxLength?: number;
  autoComplete?: string;
  emptyText?: string;
  /** Kept in this browser only: carries the Preview chip. */
  preview?: boolean;
  /** A Preview value that is kept shows Reset beside the chip; it clears the value. */
  onReset?: () => void;
  onSave: (next: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const pencilRef = React.useRef<HTMLButtonElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const returnFocus = React.useRef(false);

  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      pencilRef.current?.focus();
    }
  }, [editing]);

  const close = () => {
    returnFocus.current = true;
    setEditing(false);
    setError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (draft.trim() === value.trim()) {
      close();
      return;
    }
    setSaving(true);
    const message = await onSave(draft);
    setSaving(false);
    if (message) setError(message);
    else close();
  };

  const lower = label.toLowerCase();
  return (
    <div className={ROW_CLASS} data-profile-field={id}>
      <dt className={LABEL_CLASS}>
        {editing ? <label htmlFor={`profile-${id}`}>{label}</label> : label}
      </dt>
      <dd className="min-w-0">
        {editing ? (
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-(--space-1)">
            <div className="flex flex-wrap items-center gap-(--space-2)">
              <input
                ref={inputRef}
                id={`profile-${id}`}
                value={draft}
                maxLength={maxLength}
                autoComplete={autoComplete}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    close();
                  }
                }}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `profile-${id}-error` : undefined}
                className={INPUT_CLASS}
              />
              <button type="submit" disabled={saving} className={PRIMARY_BUTTON_CLASS}>
                {preview ? PREVIEW_KEEP_LABEL : saving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onClick={close} className={GHOST_BUTTON_CLASS}>
                Cancel
              </button>
              {/* Preview: the title is not saved yet.
                  Handoff: E8 "Save the profile photo and title". */}
              {preview ? <PreviewChip /> : null}
            </div>
            {error ? (
              <p id={`profile-${id}-error`} role="alert" className="text-(length:--text-sm) text-ink-secondary">
                {error}
              </p>
            ) : null}
          </form>
        ) : (
          <div className="flex min-w-0 items-center gap-(--space-2)">
            <span
              className={[
                'min-w-0 truncate text-(length:--text-sm)',
                value ? 'text-ink' : 'text-ink-tertiary',
              ].join(' ')}
            >
              {value || emptyText}
            </span>
            {preview ? <PreviewChip /> : null}
            {preview && value && onReset ? (
              <button type="button" onClick={onReset} className={GHOST_BUTTON_CLASS}>
                Reset
              </button>
            ) : null}
            <button
              ref={pencilRef}
              type="button"
              aria-label={`Edit ${lower}`}
              title={`Edit ${lower}`}
              onClick={() => {
                setDraft(value);
                setError(null);
                setEditing(true);
              }}
              className={ICON_BUTTON_CLASS}
            >
              <Pencil strokeWidth={1.75} className="size-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </dd>
    </div>
  );
}

/** The nickname to show: empty when there is none or it repeats the full name. */
function nicknameShown(fullName: string | null | undefined, displayName: string | null | undefined): string {
  const nickname = displayName?.trim() ?? '';
  return nickname && nickname !== (fullName ?? '').trim() ? (displayName ?? '') : '';
}

/**
 * Settings › Profile: photo, full name, nickname, title, role, email. Nothing
 * else. The photo lives in this browser only (useProfilePhoto), so
 * no copy here says it is saved to the account; the title is a Preview until
 * the profile API carries it.
 */
export function ProfileView() {
  const { state, reload } = useCurrentUser();
  const userId = state.status === 'ready' ? state.data.user.id : null;
  const { photoUrl, savePhoto } = useProfilePhoto(userId);
  const { signOut, signingOut, error: signOutError } = useSignOut();
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [title, setTitle] = useProfileTitlePreview(userId);

  const onPhotoSelected = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        setUploadError('Select an image file.');
        return;
      }
      if (file.size > MAX_PHOTO_BYTES) {
        setUploadError('Image must be 4 MB or less.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const nextUrl = typeof reader.result === 'string' ? reader.result : null;
        if (!nextUrl) {
          setUploadError('Photo upload failed. Try again.');
          return;
        }
        // A photo the browser cannot keep is not shown as if it were kept:
        // the previous one stays.
        setUploadError(savePhoto(nextUrl) ? null : PHOTO_NOT_KEPT);
      };
      reader.onerror = () => setUploadError('Photo upload failed. Try again.');
      reader.readAsDataURL(file);
    },
    [savePhoto],
  );

  /** PATCH /api/v1/me with one field; resolves to an error message or null. */
  const saveField = React.useCallback(
    async (body: { fullName: string } | { displayName: string | null }, saved: string) => {
      setNotice(null);
      try {
        const res = await fetch('/api/v1/me', {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => null)) as { error?: string } | null;
          return err?.error || 'The profile could not be saved. Try again.';
        }
        await reload?.();
        setNotice(saved);
        return null;
      } catch {
        return 'The profile could not be saved. Try again.';
      }
    },
    [reload],
  );

  if (state.status === 'loading') {
    return <p className="font-mono text-(length:--text-sm) text-ink-secondary">Loading profile…</p>;
  }

  if (state.status === 'error') {
    return (
      <p className="font-mono text-(length:--text-sm) text-ink-secondary">
        Profile is unavailable right now.
      </p>
    );
  }

  const user = state.data.user;
  const initials = initialsFor(user);

  return (
    <div className="flex w-full max-w-[880px] flex-col gap-(--space-4)">
      <article className="rounded-card border border-[var(--stroke)] bg-surface px-(--space-6) py-(--space-5)">
        <div className="flex flex-col gap-(--space-5) md:flex-row md:items-start md:gap-(--space-8)">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Change photo"
            className="group relative inline-flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--stroke-strong)] bg-[var(--surface-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            {photoUrl ? (
              <span
                aria-hidden="true"
                className="size-full bg-cover bg-center"
                style={{ backgroundImage: `url(${photoUrl})` }}
              />
            ) : (
              <span aria-hidden="true" className="font-mono text-(length:--text-md) font-semibold text-ink-secondary transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0">
                {initials}
              </span>
            )}
            <span
              aria-hidden="true"
              className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-[color-mix(in_srgb,var(--ink)_62%,transparent)] text-(length:--text-xxs) font-medium text-[var(--ink-on-dark)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
            >
              <Camera strokeWidth={1.75} className="size-4" />
              Change photo
            </span>
          </button>

          <dl className="min-w-0 flex-1">
            <EditableField
              id="full-name"
              label="Full name"
              value={user.full_name}
              maxLength={PROFILE_FULL_NAME_MAX_LENGTH}
              autoComplete="name"
              onSave={(next) => {
                const checked = checkProfileFullName(next);
                if (!checked.ok) return Promise.resolve(checked.message);
                return saveField({ fullName: checked.value }, 'Full name saved.');
              }}
            />
            {/* A nickname that only repeats the full name is no nickname:
                the field reads empty ("Not set") rather than echo the name
                above it. Display only: nothing is saved unless the banker
                types a new nickname. */}
            <EditableField
              id="nickname"
              label="Nickname"
              value={nicknameShown(user.full_name, user.display_name)}
              maxLength={PROFILE_DISPLAY_NAME_MAX_LENGTH}
              autoComplete="nickname"
              onSave={(next) => {
                const checked = checkProfileDisplayName(next);
                if (!checked.ok) return Promise.resolve(checked.message);
                return saveField({ displayName: checked.value }, 'Nickname saved.');
              }}
            />
            {/* Preview: the profile API has no title field yet.
                Handoff: E8 "Save the profile photo and title". */}
            <EditableField
              id="title"
              label="Title"
              value={title}
              maxLength={PROFILE_FULL_NAME_MAX_LENGTH}
              autoComplete="organization-title"
              preview
              onReset={() => {
                setTitle('');
                setNotice(null);
              }}
              onSave={(next) => {
                setTitle(next.trim());
                setNotice(null);
                return Promise.resolve(null);
              }}
            />
            <ProfileRoleField user={user} onSaved={setNotice} />
            <div className={ROW_CLASS} data-profile-field="email">
              <dt className={LABEL_CLASS}>Email</dt>
              <dd className="min-w-0 truncate text-(length:--text-sm) text-ink">{user.email}</dd>
            </div>
          </dl>
        </div>

        <p role="status" aria-live="polite" className="mt-(--space-3) text-(length:--text-sm) text-ink-secondary empty:mt-0">
          {uploadError ?? notice ?? ''}
        </p>
        <ConnectResult />
      </article>

      {/* Phones have no avatar menu or sidebar footer: sign out lives here. */}
      <div className="flex flex-col items-start gap-(--space-2) md:hidden">
        <button
          type="button"
          disabled={signingOut}
          onClick={() => void signOut()}
          className="inline-flex h-11 items-center justify-center rounded-button border border-[var(--stroke-strong)] bg-surface px-(--space-5) text-(length:--text-sm) font-medium text-ink transition-colors hover:bg-[var(--surface-subtle)] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
        {signOutError ? (
          <p role="status" className="text-(length:--text-sm) text-ink-secondary">
            {signOutError}
          </p>
        ) : null}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPhotoSelected}
        aria-label="Choose profile photo"
      />
    </div>
  );
}
