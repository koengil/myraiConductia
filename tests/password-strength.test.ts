import { describe, expect, it } from 'vitest';
import { passwordStrength } from '@/lib/auth/passwordStrength';

describe('passwordStrength', () => {
  it('gates on the 8-char server minimum', () => {
    expect(passwordStrength('Ab1!x').label).toBe('Too short');
    expect(passwordStrength('').score).toBe(0);
  });

  it('short single-class passwords are weak', () => {
    expect(passwordStrength('barnacles').label).toBe('Weak');
    expect(passwordStrength('12345678').label).toBe('Weak');
  });

  it('length or variety alone reads as fair', () => {
    expect(passwordStrength('correcthorsebat').label).toBe('Fair'); // 12+, one class
    expect(passwordStrength('Abc123!x').label).toBe('Fair'); // short, 4 classes
  });

  it('length plus variety reads as strong', () => {
    expect(passwordStrength('Atlas-Rangers-2026').label).toBe('Strong');
    expect(passwordStrength('correct horse battery staple').label).toBe('Strong'); // 16+ two classes
  });

  it('repetition never counts as strength', () => {
    expect(passwordStrength('aaaaAAAA1111!!!!').label).toBe('Weak');
  });
});
