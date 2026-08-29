import {
    passwordEntrySchema,
    type PasswordEntry,
    type PasswordEntryMasked,
    type PasswordStatus
} from '../contracts/domain';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';

import type { PasswordRepo } from './repo';

export type Ctx = SdkFeatureContext<PasswordRepo>;

export const WRITE = { level: 'write' } as const;

/**
 * Un seul chiffre, toujours l'étage gardé : le serveur ne lit une entrée que si
 * le chiffrement par mot de passe est éteint ou la session déverrouillée. Une
 * lecture sur une session scellée répond `locked`, et le client rouvre l'invite
 * (`withSecrecy`).
 */
export function vaultCipher(ctx: Ctx): SdkCipher {
    return ctx.cipher('private');
}

/**
 * Throws `locked` (the client prompts for the password) when password-based
 * encryption is on and the session is not unlocked; no-op when it is off. Asked
 * BEFORE reading: an empty list is not a locked list.
 */
export async function assertUnlocked(ctx: Ctx): Promise<void> {
    try {
        if (!(await ctx.secrecy.isUnlocked())) {
            throw new FeatureError('locked', 'Password encryption is locked; unlock with your password');
        }
    } catch (e) {
        if (e instanceof FeatureError) throw e;
        // DB/infra error (e.g. migration not yet applied): let through rather
        // than masking all passwords as locked.
        ctx.logger.warn({ err: e }, 'assertUnlocked: failed to check lock state, assuming unlocked');
    }
}

/**
 * Stored payload (encrypted as `passwords.content`). Mirrors PasswordEntry
 * minus the row id which lives on the SQL row.
 */
export interface StoredPayload {
    category: string;
    service: string;
    email: string;
    password: string;
    status: PasswordStatus;
}

export async function encryptPayload(cipher: SdkCipher, payload: StoredPayload): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

export async function tryDecryptPayload(cipher: SdkCipher, content: string): Promise<StoredPayload | null> {
    const plain = await cipher.tryDecrypt(content);
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
