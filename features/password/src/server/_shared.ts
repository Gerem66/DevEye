import {
    passwordEntrySchema,
    type PasswordEntry,
    type PasswordEntryMasked,
    type PasswordStatus
} from '../contracts/domain';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';

import type { PasswordRepo } from './repo';

/** Le contexte d'une commande du Coffre : le contexte du SDK, sur le dépôt du module. */
export type Ctx = SdkFeatureContext<PasswordRepo>;

/**
 * Le socle du Coffre.
 *
 * **Un seul chiffre, toujours l'étage gardé.** C'est la promesse du coffre
 * (voir `SHAREABLE_FEATURES` dans le registre publié) : le serveur ne sait
 * lire une entrée que si le chiffrement par mot de passe est éteint, ou si la
 * session a été déverrouillée. `ctx.cipher('private')` est l'ex `ctx.secure` ;
 * une lecture sur une session scellée répond `locked`, et le client rouvre
 * l'invite (`withSecrecy`).
 *
 * Depuis le rapatriement, la lecture est implicite (le défaut du SDK) : seules
 * les écritures déclarent leur niveau.
 */
export const WRITE = { level: 'write' } as const;

/** L'étage gardé du chiffrement (`'private'`), l'ex `ctx.secure`. */
export function vaultCipher(ctx: Ctx): SdkCipher {
    return ctx.cipher('private');
}

/**
 * Ensure the password-based encryption DEK is available this session. No-op
 * when the feature is off; throws `locked` (client prompts for the password)
 * when it's on but the session hasn't been unlocked yet.
 *
 * L'ex `assertSecureUnlocked`, qui lisait `ctx.secure.isUnlocked()` : la même
 * question, posée au verrou du SDK. Elle se pose AVANT de lire, parce que la
 * réponse change la forme de la réponse : une liste vide n'est pas une liste
 * verrouillée.
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
