import { AvatarInitials } from '@/components/atoms';

export interface ProfileIdentityProps {
  name: string;
  roleLabel: string;
  initials: string;
  tone?: 'on-light' | 'on-dark';
  compact?: boolean;
}

export function ProfileIdentity({
  name,
  roleLabel,
  initials,
  tone = 'on-light',
  compact = false,
}: ProfileIdentityProps) {
  const onDark = tone === 'on-dark';

  return (
    <>
      <AvatarInitials initials={initials} tone={tone} />
      <span className={`${compact ? 'hidden' : 'flex'} min-w-0 flex-col items-start text-left leading-tight`}>
        <span
          className="truncate text-[length:var(--text-sm)] font-medium tracking-tight"
          style={{ color: onDark ? 'var(--shell-ink)' : 'var(--ink)' }}
        >
          {name}
        </span>
        <span
          className="text-left text-[length:var(--text-xs)] tracking-tight"
          style={{
            color: onDark
              ? 'var(--shell-ink-muted)'
              : 'var(--ink-secondary)',
          }}
        >
          {roleLabel}
        </span>
      </span>
    </>
  );
}

export default ProfileIdentity;
