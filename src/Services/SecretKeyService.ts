import argon2 from 'argon2';
import crypto from 'crypto';

import type { Database } from '@/db';
import type { WrapState } from '@/db/repos/userSecretKeys';
import type { SecrecyWrapMode, UserSecretKeyRow } from '@deveye/types';
import Encryption from './Encryption';
import { userDekContext, userOpenDekContext, workspaceDekContext } from './sealContexts';

/**
 * Les profils Argon2id de la clé d'emballage (KEK), par version. La version
 * d'une ligne dit avec quel profil son emballage a été dérivé : monter le coût
 * n'exige donc aucune migration, une ligne se ré-emballe au déverrouillage
 * suivant (`needsKdfUpgrade`). Le profil 1 est le minimum OWASP, le même que le
 * hachage de connexion ; le 2 coûte ~5x plus au cracking hors ligne, pour un
 * déverrouillage qui reste sous le quart de seconde.
 */
const KDF_VERSIONS: Record<number, argon2.Options & { raw: true }> = {
    1: { type: argon2.argon2id, raw: true, hashLength: 32, memoryCost: 19_456, timeCost: 2, parallelism: 1 },
    2: { type: argon2.argon2id, raw: true, hashLength: 32, memoryCost: 65_536, timeCost: 3, parallelism: 1 }
};

export const CURRENT_KDF_VERSION = 2;

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

    /** Derive a 32-byte key from a password and salt (Argon2id), under the given KDF version. */
    private async deriveKey(password: string, salt: Buffer, version: number): Promise<Buffer> {
        const params = KDF_VERSIONS[version];
        if (!params) throw new Error(`Unknown KDF version ${version}`);
        const out = await argon2.hash(password, { ...params, salt });
        const key = Buffer.from(out);
        out.fill(0);
        return key;
    }

    /**
     * Fetch the user's secret-key row, creating a fresh server-wrapped DEK on
     * first use so encrypted writes work before the feature is ever touched.
     */
    async ensureRow(userId: number): Promise<UserSecretKeyRow> {
        const existing = await this.db.userSecretKeys.get(userId);
        if (existing) return existing;
        await this.db.userSecretKeys.create(
            userId,
            this.crypt.sealFor('user-dek', crypto.randomBytes(DEK_BYTES), userDekContext(userId))
        );
        const row = await this.db.userSecretKeys.get(userId);
        if (!row) throw new Error('Failed to create user secret key');
        return row;
    }

    /**
     * Pose la clé de données d'un espace partagé (WDK), à sa naissance. Toujours
     * emballée par la clé serveur, jamais par un mot de passe : tout membre lit
     * l'espace, les tâches de fond aussi. Sans effet si l'espace a déjà la sienne.
     */
    async createWorkspaceDek(workspaceId: number): Promise<void> {
        await this.db.workspaceSecretKeys.create(
            workspaceId,
            this.crypt.sealFor('workspace-dek', crypto.randomBytes(DEK_BYTES), workspaceDekContext(workspaceId))
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
        const dek = this.crypt.openFor('workspace-dek', row.dek_wrapped, workspaceDekContext(workspaceId));
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
            await this.db.userSecretKeys.setOpenDek(
                userId,
                this.crypt.sealFor('user-open-dek', crypto.randomBytes(DEK_BYTES), userOpenDekContext(userId))
            );
            // Re-read rather than trust `wrapped`: a concurrent first write may
            // have landed first, and its key is the one the content will use.
            const stored = (await this.db.userSecretKeys.get(userId))?.open_dek_wrapped;
            if (!stored) throw new Error('Failed to create user open DEK');
            row.open_dek_wrapped = stored;
        }
        const dek = this.crypt.openFor('user-open-dek', row.open_dek_wrapped, userOpenDekContext(userId));
        if (!dek) throw new Error('Open DEK failed to decrypt (server key changed?)');
        return dek;
    }

    /** True when the user's DEK is currently wrapped by their password. */
    isPasswordWrapped(row: UserSecretKeyRow): boolean {
        return row.wrap_mode === 'password';
    }

    /** True when a password-wrapped row was derived under an older KDF profile. */
    needsKdfUpgrade(row: UserSecretKeyRow): boolean {
        return row.wrap_mode === 'password' && row.version !== CURRENT_KDF_VERSION;
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
        const dek = this.crypt.openFor('user-dek', row.dek_wrapped, userDekContext(row.user_id));
        if (!dek) throw new Error('Server-wrapped DEK failed to decrypt (server key changed?)');
        return dek;
    }

    /** Unwrap the DEK with the user's password. Throws {@link WrongSecretError}. */
    async unwrapWithPassword(row: UserSecretKeyRow, password: string): Promise<Buffer> {
        if (row.wrap_mode !== 'password' || !row.kdf_salt) {
            throw new Error('DEK is not password-wrapped');
        }
        const key = await this.deriveKey(password, Buffer.from(row.kdf_salt), row.version);
        try {
            const dek = Encryption.decryptWithKeyRaw(key, row.dek_wrapped);
            if (!dek) throw new WrongSecretError();
            return dek;
        } finally {
            key.fill(0);
        }
    }

    /** Unwrap the DEK with a recovery code. Throws {@link WrongSecretError}. */
    async unwrapWithRecovery(row: UserSecretKeyRow, recoveryCode: string): Promise<Buffer> {
        if (!row.recovery_wrapped || !row.recovery_salt) {
            throw new Error('No recovery code configured');
        }
        const key = await this.deriveKey(
            normalizeRecoveryCode(recoveryCode),
            Buffer.from(row.recovery_salt),
            row.recovery_version
        );
        try {
            const dek = Encryption.decryptWithKeyRaw(key, row.recovery_wrapped);
            if (!dek) throw new WrongSecretError();
            return dek;
        } finally {
            key.fill(0);
        }
    }

    /**
     * Resolve the DEK for read/write when the feature is OFF (server-wrapped).
     * Convenience for the password-mode-not-set path.
     */
    resolveServerDek(row: UserSecretKeyRow): Buffer {
        return this.unwrapWithServer(row);
    }

    /**
     * The Argon2 work of a password (re-)wrap, without touching the database:
     * what {@link wrapWithPassword} and {@link rewrapPasswordAndHash} then
     * write. Optionally (re)generate a recovery code, returned in clear once;
     * `'keep'` carries the existing recovery copy over unchanged.
     */
    async prepareWrapWithPassword(
        dek: Buffer,
        password: string,
        recovery: 'generate' | 'keep' | 'none',
        existing: UserSecretKeyRow
    ): Promise<{ state: WrapState; recoveryCode?: string }> {
        const salt = crypto.randomBytes(SALT_BYTES);
        const key = await this.deriveKey(password, salt, CURRENT_KDF_VERSION);
        let dekWrapped: string;
        try {
            dekWrapped = Encryption.encryptWithKey(key, dek);
        } finally {
            key.fill(0);
        }

        let recoveryWrapped: string | null = null;
        let recoverySalt: Buffer | null = null;
        let recoveryVersion = CURRENT_KDF_VERSION;
        let recoveryCode: string | undefined;

        if (recovery === 'generate') {
            recoveryCode = generateRecoveryCode();
            recoverySalt = crypto.randomBytes(SALT_BYTES);
            const recKey = await this.deriveKey(normalizeRecoveryCode(recoveryCode), recoverySalt, CURRENT_KDF_VERSION);
            try {
                recoveryWrapped = Encryption.encryptWithKey(recKey, dek);
            } finally {
                recKey.fill(0);
            }
        } else if (recovery === 'keep') {
            recoveryWrapped = existing.recovery_wrapped;
            recoverySalt = existing.recovery_salt ? Buffer.from(existing.recovery_salt) : null;
            recoveryVersion = existing.recovery_version;
        }

        const state: WrapState = {
            dekWrapped,
            wrapMode: 'password',
            kdfSalt: salt,
            version: CURRENT_KDF_VERSION,
            recoveryWrapped,
            recoverySalt,
            recoveryVersion
        };
        return { state, recoveryCode };
    }

    /**
     * Re-wrap the DEK with the user's password (enable, recovery-code renewal,
     * KDF upgrade). Optionally (re)generate a recovery code, returned in clear
     * once. `'keep'` preserves the existing recovery copy unchanged.
     */
    async wrapWithPassword(
        userId: number,
        dek: Buffer,
        password: string,
        recovery: 'generate' | 'keep' | 'none',
        existing: UserSecretKeyRow
    ): Promise<{ recoveryCode?: string }> {
        const { state, recoveryCode } = await this.prepareWrapWithPassword(dek, password, recovery, existing);
        await this.db.userSecretKeys.setWrap(userId, state);
        return { recoveryCode };
    }

    /**
     * A password change: the new wrap and the new account hash land in one
     * transaction. Written apart, a failure between the two would leave a DEK
     * only the new password opens behind a login only the old one passes.
     */
    async rewrapPasswordAndHash(userId: number, state: WrapState, passwordHash: string): Promise<void> {
        await this.db.transaction(async (tx) => {
            await tx.userSecretKeys.setWrap(userId, state);
            await tx.users.updatePasswordHash(userId, passwordHash);
        });
    }

    /** Re-wrap the DEK with the server key (disable). Clears recovery material. */
    async wrapWithServer(userId: number, dek: Buffer): Promise<void> {
        const state: WrapState = {
            dekWrapped: this.crypt.sealFor('user-dek', dek, userDekContext(userId)),
            wrapMode: 'server',
            kdfSalt: null,
            version: CURRENT_KDF_VERSION,
            recoveryWrapped: null,
            recoverySalt: null,
            recoveryVersion: CURRENT_KDF_VERSION
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
