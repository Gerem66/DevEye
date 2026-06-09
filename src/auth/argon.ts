import argon2 from 'argon2';
import bcrypt from 'bcryptjs';

const ARGON_OPTIONS: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1
};

export async function hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
    try {
        // Legacy bcrypt hashes from the previous app ($2a/$2b/$2y).
        if (hash.startsWith('$2')) {
            return await bcrypt.compare(plain, hash);
        }
        return await argon2.verify(hash, plain);
    } catch {
        return false;
    }
}

/** True when the stored hash is not argon2id and should be upgraded after a successful login. */
export function needsRehash(hash: string): boolean {
    return !hash.startsWith('$argon2');
}
