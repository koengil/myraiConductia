/**
 * Password strength heuristic for account setup surfaces (accept-invite).
 * Deliberately dependency-free: length and character variety cover the
 * guidance we give (NIST-style, length first), and the server minimum
 * (8 chars, enforced by Supabase and the input) stays the hard gate.
 */

export type PasswordStrength = {
  /** 0 = too short, 1 = weak, 2 = fair, 3 = strong */
  score: 0 | 1 | 2 | 3;
  label: 'Too short' | 'Weak' | 'Fair' | 'Strong';
};

export const PASSWORD_MIN_LENGTH = 8;

export const PASSWORD_HINT =
  'At least 8 characters. 12 or more with a mix of cases, numbers, and symbols is strong.';

export function passwordStrength(password: string): PasswordStrength {
  if (password.length < PASSWORD_MIN_LENGTH) return { score: 0, label: 'Too short' };

  const classes =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/[0-9]/.test(password)) +
    Number(/[^a-zA-Z0-9]/.test(password));

  // Length carries the most weight; variety upgrades it. Repeating a single
  // character never counts as variety-driven strength.
  const distinct = new Set(password).size;
  let points = 0;
  if (password.length >= 12) points += 1;
  if (password.length >= 16) points += 1;
  if (classes >= 3) points += 1;
  if (distinct < 5) points = 0;

  if (points >= 2) return { score: 3, label: 'Strong' };
  if (points === 1) return { score: 2, label: 'Fair' };
  return { score: 1, label: 'Weak' };
}
