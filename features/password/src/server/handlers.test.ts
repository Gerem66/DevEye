import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    passwordAdd,
    passwordCount,
    passwordDelete,
    passwordEdit,
    passwordGet,
    passwordList
} from '../contracts/commands';
import type { PasswordRow } from '../contracts/domain';
import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { passwordHandlers } from './handlers';
import type { PasswordRepo } from './repo';

/**
 * Ce qui se vérifie ici ne lève nulle part ailleurs : la liste ne rend jamais un
 * mot de passe, seule `password.get` le rend et seulement déverrouillée, et le
 * compte de la carte d'accueil répond même verrouillé.
 */

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = passwordHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<PasswordRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

interface FakeRepo extends PasswordRepo {
    rows: PasswordRow[];
}

/** Un dépôt en mémoire, même contrat que le vrai. Le tableau est muté en
 *  place, jamais réassigné : les tests lisent `repo.rows` après coup. */
function fakeRepo(): FakeRepo {
    let seq = 0;
    return {
        rows: [],
        async listByWorkspace(workspaceId) {
            return this.rows.filter((r) => r.workspace_id === workspaceId);
        },
        async countByWorkspace(workspaceId) {
            return this.rows.filter((r) => r.workspace_id === workspaceId).length;
        },
        async findById(id, workspaceId) {
            return this.rows.find((r) => r.id === id && r.workspace_id === workspaceId) ?? null;
        },
        async create({ userId, workspaceId, content }) {
            const row: PasswordRow = {
                id: ++seq,
                user_id: userId,
                workspace_id: workspaceId,
                content,
                date: Date.now()
            };
            this.rows.push(row);
            return row;
        },
        async update(id, workspaceId, content) {
            const row = await this.findById(id, workspaceId);
            if (!row) return null;
            row.content = content;
            return row;
        },
        async delete(id, workspaceId) {
            const i = this.rows.findIndex((r) => r.id === id && r.workspace_id === workspaceId);
            if (i === -1) return false;
            this.rows.splice(i, 1);
            return true;
        }
    };
}

const ENTRY = {
    category: 'Web',
    service: 'GitHub',
    email: 'gerem@example.com',
    password: 's3cret',
    status: 'active' as const
};

/** Le refus attendu d'une session scellée : `locked`, et rien d'autre. */
function isLocked(e: unknown): boolean {
    return e instanceof FeatureError && e.code === 'locked';
}

describe('password.list', () => {
    it('rend les entrées masquées, jamais le mot de passe', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        await handlerFor(passwordAdd)(ctx, { entry: ENTRY });
        await handlerFor(passwordAdd)(ctx, { entry: { ...ENTRY, service: 'Sans secret', password: '' } });

        const listed = await handlerFor(passwordList)(ctx, {});
        assert.equal(listed.entries.length, 2);
        assert.equal(listed.entries[0].service, 'GitHub');
        assert.equal(listed.entries[0].password, '');
        // Le masque dit qu'un secret existe, sans le montrer ; une entrée
        // vraiment vide se distingue d'une entrée masquée.
        assert.equal(listed.entries[0].hasPassword, true);
        assert.equal(listed.entries[1].hasPassword, false);
        assert.ok(!JSON.stringify(listed).includes('s3cret'));
    });
});

describe('le verrou', () => {
    it("refuse la liste et la lecture sur une session scellée, avec le code que l'invite attend", async () => {
        const repo = fakeRepo();
        const added = await handlerFor(passwordAdd)(createTestContext({ repo }), { entry: ENTRY });

        const locked = createTestContext({ repo, unlocked: false });
        await assert.rejects(handlerFor(passwordList)(locked, {}), isLocked);
        await assert.rejects(handlerFor(passwordGet)(locked, { passwordId: added.entry.id }), isLocked);
    });

    it('compte quand même : la carte d’accueil ne dépend pas du mot de passe', async () => {
        const repo = fakeRepo();
        await handlerFor(passwordAdd)(createTestContext({ repo }), { entry: ENTRY });

        const locked = createTestContext({ repo, unlocked: false });
        assert.deepEqual(await handlerFor(passwordCount)(locked, {}), { count: 1 });
        // Borné à l'espace : un autre espace ne voit rien.
        assert.deepEqual(await handlerFor(passwordCount)(createTestContext({ repo, workspaceId: 7 }), {}), {
            count: 0
        });
    });
});

describe('password.add / password.get', () => {
    it("chiffre la charge par le cipher gardé et rend l'entrée en clair", async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });

        const added = await handlerFor(passwordAdd)(ctx, { entry: ENTRY });
        assert.equal(added.entry.id, 1);
        assert.equal(added.entry.password, 's3cret');
        // Le harnais chiffre à l'identité : la charge doit être passée par le
        // cipher, en JSON, jamais posée en clair dans une colonne à part.
        assert.deepEqual(JSON.parse(repo.rows[0].content), ENTRY);
        assert.equal(ctx.recorded.audits.length, 1);
        assert.equal(ctx.recorded.audits[0].action, 'password.create');

        const read = await handlerFor(passwordGet)(ctx, { passwordId: added.entry.id });
        assert.deepEqual(read.entry, { id: 1, ...ENTRY });
        await assert.rejects(handlerFor(passwordGet)(ctx, { passwordId: 99 }), /not found/i);
    });
});

describe('password.edit', () => {
    it("remplace la charge, et la relecture la rend telle qu'écrite", async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const added = await handlerFor(passwordAdd)(ctx, { entry: ENTRY });

        const edited = await handlerFor(passwordEdit)(ctx, {
            entry: { ...ENTRY, id: added.entry.id, password: 'n3w', status: 'inactive' }
        });
        assert.equal(edited.entry.password, 'n3w');
        assert.equal(edited.entry.status, 'inactive');

        const read = await handlerFor(passwordGet)(ctx, { passwordId: added.entry.id });
        assert.equal(read.entry.password, 'n3w');
        assert.equal(ctx.recorded.audits.at(-1)?.action, 'password.edit');

        await assert.rejects(handlerFor(passwordEdit)(ctx, { entry: { ...ENTRY, id: 99 } }), /not found/i);
    });
});

describe('password.delete', () => {
    it("retire la ligne, et le compte suit ; une seconde suppression n'a plus rien à retirer", async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const added = await handlerFor(passwordAdd)(ctx, { entry: ENTRY });

        const removed = await handlerFor(passwordDelete)(ctx, { passwordId: added.entry.id });
        assert.equal(removed.passwordId, added.entry.id);
        assert.equal(repo.rows.length, 0);
        assert.deepEqual(await handlerFor(passwordCount)(ctx, {}), { count: 0 });
        assert.equal(ctx.recorded.audits.at(-1)?.action, 'password.delete');

        await assert.rejects(handlerFor(passwordDelete)(ctx, { passwordId: added.entry.id }), /not found/i);
    });
});
