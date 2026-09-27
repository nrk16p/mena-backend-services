import type { ClientSession, Db, ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { hashPassword } from '../../lib/passwords.js';
import { ROLES, type Role } from '../../lib/roles.js';

export interface UserDoc {
  _id: ObjectId;
  username: string;
  passwordHash: string;
  roles: Role[];
  driverId: ObjectId | null;
  active: boolean;
  lastLogin: { at: Date; lat: number | null; lng: number | null } | null;
  createdAt: Date;
  updatedAt: Date;
}

export const UserOutSchema = z.object({
  id: z.string(),
  username: z.string(),
  roles: z.array(z.enum(ROLES)),
  driverId: z.string().nullable(),
});

export async function createUser(
  db: Db,
  input: { username: string; password: string; roles: Role[]; driverId?: ObjectId | null },
  opts: { session?: ClientSession } = {},
): Promise<UserDoc> {
  const now = new Date();
  const doc: Omit<UserDoc, '_id'> = {
    username: input.username.trim(),
    passwordHash: await hashPassword(input.password),
    roles: input.roles,
    driverId: input.driverId ?? null,
    active: true,
    lastLogin: null,
    createdAt: now,
    updatedAt: now,
  };
  const res = await db.collection<UserDoc>(C.users).insertOne({ ...doc } as UserDoc, { session: opts.session });
  return { ...doc, _id: res.insertedId };
}

export function findUserByUsername(db: Db, username: string) {
  return db.collection<UserDoc>(C.users).findOne({ username: username.trim() });
}

export function findUserById(db: Db, id: ObjectId) {
  return db.collection<UserDoc>(C.users).findOne({ _id: id });
}

export function userOut(u: UserDoc): z.infer<typeof UserOutSchema> {
  return { id: u._id.toHexString(), username: u.username, roles: u.roles, driverId: u.driverId?.toHexString() ?? null };
}
