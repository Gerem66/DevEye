import type { SecureStore } from '@/Services/SecureStore';
import type { PasswordEntry, PasswordEntryMasked, PasswordStatus } from 'deveye-types';
import { passwordEntrySchema } from 'deveye-types';

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

export async function encryptPayload(secure: SecureStore, payload: StoredPayload): Promise<string> {
    return secure.encrypt(JSON.stringify(payload));
}

export async function tryDecryptPayload(secure: SecureStore, content: string): Promise<StoredPayload | null> {
    const plain = await secure.tryDecrypt(content);
    if (plain === null) return null;
    try {
        return JSON.parse(plain) as StoredPayload;
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
        hasPassword: payload.password !== '',
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
