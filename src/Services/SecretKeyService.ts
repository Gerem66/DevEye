import argon2 from 'argon2';
import crypto from 'crypto';

import type { Database } from '@/db';
import type { WrapState } from '@/db/repos/userSecretKeys';
import type { SecrecyWrapMode, UserSecretKeyRow } from '@deveye/types';
import Encryption from './Encryption';

/** Argon2id parameters for deriving a 32-byte key-encryption key from a password. */
const KDF: argon2.Options & { raw: true } = {
    type: argon2.argon2id,
    raw: true,
    hashLength: 32,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1
};

const DEK_BYTES = 32;
const SALT_BYTES = 16;

/** Raw error thrown when a password/recovery code fails to unwrap the DEK. */
export class WrongSecretError extends Error {
    constructor() {
        super('Wrong password or recovery code');
        this.name = 'WrongSecretError';
    }
}

/**
 * Envelope-encryption authority. Owns the per-user DEK lifecycle: lazy
 * creation, wrapping/unwrapping with the server key or a password-derived key,
 * and the optional recovery copy. Holds no per-session state — callers cache
 * the unwrapped DEK themselves (see {@link SecureStore}).
 */
export class SecretKeyService {
    constructor(
        private readonly db: Database,
        private readonly crypt: Encryption
    ) {}

    /** Derive a 32-byte key from a password and salt (Argon2id). */
    private async deriveKey(password: string, salt: Buffer): Promise<Buffer> {
        const out = await argon2.hash(password, { ...KDF, salt });
        return Buffer.from(out);
    }

    /**
     * Fetch the user's secret-key row, creating a fresh server-wrapped DEK on
     * first use so encrypted writes work before the feature is ever touched.
     */
    async ensureRow(userId: number): Promise<UserSecretKeyRow> {
        const existing = await this.db.userSecretKeys.get(userId);
        if (existing) return existing;
        const dek = crypto.randomBytes(DEK_BYTES);
        const wrapped = Encryption.encryptWithKey(this.crypt.serverKey(), dek);
        await this.db.userSecretKeys.create(userId, wrapped);
        const row = await this.db.userSecretKeys.get(userId);
        if (!row) throw new Error('Failed to create user secret key');
        return row;
    }

    /**
     * Pose la clé de données d'un espace partagé (WDK), à sa naissance.
     *
     * Toujours emballée par la clé serveur, jamais par un mot de passe : c'est
     * précisément ce qui permet à **tout** membre de lire l'espace, et aux tâches
     * de fond d'y travailler sans session. Même schéma que la BMK de CloudSync et
     * que l'étage ouvert. Sans effet si l'espace a déjà la sienne.
     */
    async createWorkspaceDek(workspaceId: number): Promise<void> {
        await this.db.workspaceSecretKeys.create(
            workspaceId,
            Encryption.encryptWithKey(this.crypt.serverKey(), crypto.randomBytes(DEK_BYTES))
        );
    }

    /**
     * La clé de données d'un espace partagé. Tout espace partagé la reçoit à sa
     * création (`workspace.add`) : son absence est un invariant rompu, pas un
     * état à réparer.
     */
    async resolveWorkspaceDek(workspaceId: number): Promise<Buffer> {
        const row = await this.db.workspaceSecretKeys.get(workspaceId);
        if (!row) throw new Error(`Workspace ${workspaceId} has no data key`);
        const dek = Encryption.decryptWithKeyRaw(this.crypt.serverKey(), row.dek_wrapped);
        if (!dek) throw new Error('Workspace DEK failed to decrypt (server key changed?)');
        return dek;
    }

    /**
     * Fetch the user's **open DEK**, creating it on first use. Unlike the main
     * DEK this one is always server-wrapped, whatever the user's `wrap_mode`:
     * it backs the data a feature must be able to read without any password
     * prompt (see {@link SecureStore.open}). Never re-wrapped by the secrecy
     * handlers — enabling password encryption must not lock this tier.
     */
    async resolveOpenDek(userId: number): Promise<Buffer> {
        const row = await this.ensureRow(userId);
        if (!row.open_dek_wrapped) {
            const wrapped = Encryption.encryptWithKey(this.crypt.serverKey(), crypto.randomBytes(DEK_BYTES));
            await this.db.userSecretKeys.setOpenDek(userId, wrapped);
            // Re-read rather than trust `wrapped`: a concurrent first write may
            // have landed first, and its key is the one the content will use.
            const stored = (await this.db.userSecretKeys.get(userId))?.open_dek_wrapped;
            if (!stored) throw new Error('Failed to create user open DEK');
            row.open_dek_wrapped = stored;
        }
        const dek = Encryption.decryptWithKeyRaw(this.crypt.serverKey(), row.open_dek_wrapped);
        if (!dek) throw new Error('Open DEK failed to decrypt (server key changed?)');
        return dek;
    }

    /** True when the user's DEK is currently wrapped by their password. */
    isPasswordWrapped(row: UserSecretKeyRow): boolean {
        return row.wrap_mode === 'password';
    }

    /**
     * Unwrap the DEK using the server key. Only valid while the feature is OFF;
     * throws otherwise so callers don't silently rely on the server key when the
     * user expects password protection.
     */
    unwrapWithServer(row: UserSecretKeyRow): Buffer {
        if (row.wrap_mode !== 'server') {
            throw new Error('DEK is password-wrapped; server key cannot unwrap it');
        }
        const dek = Encryption.decryptWithKeyRaw(this.crypt.serverKey(), row.dek_wrapped);
        if (!dek) throw new Error('Server-wrapped DEK failed to decrypt (server key changed?)');
        return dek;
    }

    /** Unwrap the DEK with the user's password. Throws {@link WrongSecretError}. */
    async unwrapWithPassword(row: UserSecretKeyRow, password: string): Promise<Buffer> {
        if (row.wrap_mode !== 'password' || !row.kdf_salt) {
            throw new Error('DEK is not password-wrapped');
        }
        const key = await this.deriveKey(password, Buffer.from(row.kdf_salt));
        const dek = Encryption.decryptWithKeyRaw(key, row.dek_wrapped);
        if (!dek) throw new WrongSecretError();
        return dek;
    }

    /** Unwrap the DEK with a recovery code. Throws {@link WrongSecretError}. */
    async unwrapWithRecovery(row: UserSecretKeyRow, recoveryCode: string): Promise<Buffer> {
        if (!row.recovery_wrapped || !row.recovery_salt) {
            throw new Error('No recovery code configured');
        }
        const key = await this.deriveKey(normalizeRecoveryCode(recoveryCode), Buffer.from(row.recovery_salt));
        const dek = Encryption.decryptWithKeyRaw(key, row.recovery_wrapped);
        if (!dek) throw new WrongSecretError();
        return dek;
    }

    /**
     * Resolve the DEK for read/write when the feature is OFF (server-wrapped).
     * Convenience for the password-mode-not-set path.
     */
    resolveServerDek(row: UserSecretKeyRow): Buffer {
        return this.unwrapWithServer(row);
    }

    /**
     * Re-wrap the DEK with the user's password (enable / change password).
     * Optionally (re)generate a recovery code, returned in clear once.
     * `withRecovery: 'keep'` preserves the existing recovery copy unchanged.
     */
    async wrapWithPassword(
        userId: number,
        dek: Buffer,
        password: string,
        recovery: 'generate' | 'keep' | 'none',
        existing: UserSecretKeyRow
    ): Promise<{ recoveryCode?: string }> {
        const salt = crypto.randomBytes(SALT_BYTES);
        const key = await this.deriveKey(password, salt);
        const dekWrapped = Encryption.encryptWithKey(key, dek);

        let recoveryWrapped: string | null = null;
        let recoverySalt: Buffer | null = null;
        let recoveryCode: string | undefined;

        if (recovery === 'generate') {
            recoveryCode = generateRecoveryCode();
            recoverySalt = crypto.randomBytes(SALT_BYTES);
            const recKey = await this.deriveKey(normalizeRecoveryCode(recoveryCode), recoverySalt);
            recoveryWrapped = Encryption.encryptWithKey(recKey, dek);
        } else if (recovery === 'keep') {
            recoveryWrapped = existing.recovery_wrapped;
            recoverySalt = existing.recovery_salt ? Buffer.from(existing.recovery_salt) : null;
        }

        const state: WrapState = {
            dekWrapped,
            wrapMode: 'password',
            kdfSalt: salt,
            recoveryWrapped,
            recoverySalt
        };
        await this.db.userSecretKeys.setWrap(userId, state);
        return { recoveryCode };
    }

    /** Re-wrap the DEK with the server key (disable). Clears recovery material. */
    async wrapWithServer(userId: number, dek: Buffer): Promise<void> {
        const dekWrapped = Encryption.encryptWithKey(this.crypt.serverKey(), dek);
        const state: WrapState = {
            dekWrapped,
            wrapMode: 'server',
            kdfSalt: null,
            recoveryWrapped: null,
            recoverySalt: null
        };
        await this.db.userSecretKeys.setWrap(userId, state);
    }

    /** DEK read/write codec, keyed by the resolved DEK. */
    static encrypt(dek: Buffer, plaintext: string): string {
        return Encryption.encryptWithKey(dek, plaintext);
    }

    static decrypt(dek: Buffer, blob: string): string | null {
        return Encryption.decryptWithKey(dek, blob);
    }

    /** Whether a given wrap mode means the feature is enabled. */
    static modeEnabled(mode: SecrecyWrapMode): boolean {
        return mode === 'password';
    }
}

/** Human-friendly recovery code, e.g. `K7H2-9QXM-4ZPT-RW8N`. */
function generateRecoveryCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
    const groups: string[] = [];
    for (let g = 0; g < 4; g++) {
        let chunk = '';
        for (let i = 0; i < 4; i++) {
            chunk += alphabet[crypto.randomInt(alphabet.length)];
        }
        groups.push(chunk);
    }
    return groups.join('-');
}

/** Canonicalize a recovery code so display formatting doesn't affect the KDF. */
export function normalizeRecoveryCode(code: string): string {
    return code.replace(/[\s-]/g, '').toUpperCase();
}
