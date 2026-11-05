/**
 * Conductia icon set (design spec §4).
 *
 * One consistent line style: 24×24 viewBox, 1.6 stroke, round caps/joins,
 * currentColor (inherits text color → works on light + dark). No icon-library
 * dependency, matches the existing inline-SVG convention. Each icon is a
 * standalone named export so the set tree-shakes.
 *
 * `title` → accessible (role="img" + <title>); omitted → decorative
 * (aria-hidden). `size` sets both width/height (px).
 */

export interface IconProps {
  size?: number;
  /** Accessible label. Omit for a decorative icon. */
  title?: string;
  className?: string;
  /** Override stroke width (default 1.6). */
  strokeWidth?: number;
}

function Svg({
  size = 20,
  title,
  className,
  strokeWidth = 1.6,
  children,
}: IconProps & { children: React.ReactNode }) {
  const decorative = !title;
  return (
    <svg
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : title}
      aria-hidden={decorative ? true : undefined}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {!decorative && <title>{title}</title>}
      {children}
    </svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="15" r="1.3" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
    </Svg>
  );
}

export function CrossIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </Svg>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 12h15" />
      <path d="M13 6 19.5 12 13 18" />
    </Svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 12H5" />
      <path d="M11 6 4.5 12 11 18" />
    </Svg>
  );
}

export function DragHandleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="6" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1.25" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 19 5.6v5.2c0 5.3-3.2 8.6-7 11-3.8-2.4-7-5.7-7-11V5.6L12 3Z" />
      <path d="m9 12 2.4 2.4L15.5 10" />
    </Svg>
  );
}

export type IconName =
  | "lock"
  | "check"
  | "cross"
  | "arrow-right"
  | "arrow-left"
  | "drag-handle"
  | "shield";
