// Ways to forge the ActingUser brand. Every line marked FLAG must be flagged;
// the unmarked casts are harmless and must stay clean.
import type { ActingUser } from '@/lib/mailboxAccess/principal';

declare function takesUser(user: ActingUser): void;
type Alias = ActingUser;

export function forge(id: unknown, list: readonly string[]) {
  takesUser(id as ActingUser); // FLAG
  takesUser(<ActingUser>id); // FLAG angle-bracket assertion
  takesUser(id as unknown as ActingUser); // FLAG
  takesUser(id as Alias); // FLAG alias of the brand
  takesUser(id as never); // FLAG never is assignable to everything
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  takesUser(id as any); // FLAG any in a brand position
  const stored = id as never; // FLAG a stored never can flow into a brand parameter later
  takesUser(stored);

  // Clean.
  list.includes(id as never);
  const literal = ['a'] as const;
  return [literal, id as string, id as unknown];
}
