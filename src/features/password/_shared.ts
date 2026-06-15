import type Encryption from '@/Services/Encryption';
import type { PasswordEntry, PasswordEntryMasked, PasswordStatus } from 'deveye-types';
import { passwordEntrySchema } from 'deveye-types';
import { FeatureError } from '../_define';

/**
 * Stored payload (encrypted as `passwords.content`). Mirrors PasswordEntry
 * minus the row id which lives on the SQL row.
 */
interface StoredPayload {
    category: string;
    service: string;
    email: string;
    password: string;
    status: PasswordStatus;
}

export function encryptPayload(crypt: Encryption, payload: StoredPayload): string {
    return crypt.Encrypt(JSON.stringify(payload));
}

export function decryptPayload(crypt: Encryption, content: string): StoredPayload {
    const plain = crypt.Decrypt(content);
    if (plain === null) {
        throw new FeatureError('internal', 'Failed to decrypt password content');
    }
    try {
        return JSON.parse(plain) as StoredPayload;
    } catch {
        throw new FeatureError('internal', 'Corrupted password content');
    }
}

/** Non-throwing variant: returns null instead of failing (e.g. legacy rows). */
export function tryDecryptPayload(crypt: Encryption, content: string): StoredPayload | null {
    try {
        return decryptPayload(crypt, content);
    } catch {
        return null;
    }
}

export function toEntry(id: number, payload: StoredPayload): PasswordEntry {
    return passwordEntrySchema.parse({ id, ...payload });
}

export function toMaskedEntry(id: number, payload: StoredPayload): PasswordEntryMasked {
    return {
        id,
        category: payload.category,
        service: payload.service,
        email: payload.email,
        password: '',
        status: payload.status
    };
}

/**
 * In-memory unlock registry. Keyed by (sessionId, workspaceId). Reset when the
 * process restarts. Suitable for short-lived sessions; persist if you need
 * unlock survival across reconnects.
 */
const unlocked = new Map<string, Set<number>>();

export function isUnlocked(sessionId: string, workspaceId: number): boolean {
    return unlocked.get(sessionId)?.has(workspaceId) ?? false;
}

export function markUnlocked(sessionId: string, workspaceId: number): void {
    let set = unlocked.get(sessionId);
    if (!set) {
        set = new Set();
        unlocked.set(sessionId, set);
    }
    set.add(workspaceId);
}

export function forgetSession(sessionId: string): void {
    unlocked.delete(sessionId);
}
