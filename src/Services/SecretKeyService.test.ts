import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Database } from '@/db';
import type { WrapState } from '@/db/repos/userSecretKeys';
import type { UserSecretKeyRow } from '@deveye/types';
import Encryption from './Encryption';
import { CURRENT_KDF_VERSION, SecretKeyService, WrongSecretError } from './SecretKeyService';

const crypt = new Encryption('a'.repeat(32), 'b'.repeat(32));

function serverRow(userId: number, dek: Buffer): UserSecretKeyRow {
    return {
        user_id: userId,
        dek_wrapped: crypt.sealFor('user-dek', dek, `user_secret_keys:dek:${userId}`),
        open_dek_wrapped: null,
        wrap_mode: 'server',
        kdf_salt: null,
        recovery_wrapped: null,
        recovery_salt: null,
        version: 1,
        recovery_version: 1,
        created: 0,
        updated: 0
    };
}

function rowFrom(userId: number, state: WrapState): UserSecretKeyRow {
    return {
        ...serverRow(userId, Buffer.alloc(32, 1)),
        dek_wrapped: state.dekWrapped,
        wrap_mode: state.wrapMode,
        kdf_salt: state.kdfSalt,
        recovery_wrapped: state.recoveryWrapped,
        recovery_salt: state.recoverySalt,
        version: state.version,
        recovery_version: state.recoveryVersion
    };
}

/** Une base factice qui note sur QUELLE connexion chaque écriture a lieu. */
function fakeDb(opts: { failHash?: boolean } = {}): { db: Database; calls: string[] } {
    const calls: string[] = [];
    const repos = (where: string) => ({
        userSecretKeys: { setWrap: async () => void calls.push(`${where}:setWrap`) },
        users: {
            updatePasswordHash: async () => {
                if (opts.failHash) throw new Error('base indisponible');
                calls.push(`${where}:updatePasswordHash`);
            }
        }
    });
    const db = {
        ...repos('outer'),
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(repos('tx'))
    } as unknown as Database;
    return { db, calls };
}

describe('SecretKeyService', () => {
    it('le ré-emballage et le hachage du compte passent par la même transaction', async () => {
        const { db, calls } = fakeDb();
        const keys = new SecretKeyService(db, crypt);
        const dek = Buffer.alloc(32, 3);
        const { state } = await keys.prepareWrapWithPassword(dek, 'nouveau-mot-de-passe', 'none', serverRow(1, dek));
        assert.deepEqual(calls, [], 'préparer ne touche pas à la base');
        await keys.rewrapPasswordAndHash(1, state, 'hash');
        assert.deepEqual(calls, ['tx:setWrap', 'tx:updatePasswordHash']);
    });

    it('un hachage qui échoue fait échouer le tout, sans écriture hors transaction', async () => {
        const { db, calls } = fakeDb({ failHash: true });
        const keys = new SecretKeyService(db, crypt);
        const dek = Buffer.alloc(32, 4);
        const { state } = await keys.prepareWrapWithPassword(dek, 'nouveau-mot-de-passe', 'none', serverRow(1, dek));
        await assert.rejects(keys.rewrapPasswordAndHash(1, state, 'hash'), /indisponible/);
        assert.ok(!calls.some((c) => c.startsWith('outer:')));
    });

    it('un emballage par mot de passe se rouvre, refuse un mauvais secret, et porte le profil courant', async () => {
        const keys = new SecretKeyService(fakeDb().db, crypt);
        const dek = Buffer.alloc(32, 5);
        const { state, recoveryCode } = await keys.prepareWrapWithPassword(
            dek,
            'un-mot-de-passe',
            'generate',
            serverRow(7, dek)
        );
        assert.equal(state.version, CURRENT_KDF_VERSION);
        const row = rowFrom(7, state);
        assert.ok((await keys.unwrapWithPassword(row, 'un-mot-de-passe')).equals(dek));
        assert.ok((await keys.unwrapWithRecovery(row, recoveryCode ?? '')).equals(dek));
        await assert.rejects(keys.unwrapWithPassword(row, 'autre'), WrongSecretError);
        assert.equal(keys.needsKdfUpgrade(row), false);
        assert.equal(keys.needsKdfUpgrade({ ...row, version: 1 }), true);
    });

    it('la DEK serveur ne s’ouvre que pour sa propre ligne', () => {
        const keys = new SecretKeyService(fakeDb().db, crypt);
        const dek = Buffer.alloc(32, 6);
        const row = serverRow(1, dek);
        assert.ok(keys.unwrapWithServer(row).equals(dek));
        // Le même blob recopié sur la ligne d'un autre compte.
        assert.throws(() => keys.unwrapWithServer({ ...row, user_id: 2 }), /failed to decrypt/);
    });
});
