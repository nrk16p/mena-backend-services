import argon2 from 'argon2';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
// Used to spend the same time on unknown usernames as on wrong passwords.
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('dummy-password-for-constant-time-login');
  return dummy;
}
