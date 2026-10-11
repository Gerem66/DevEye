import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeatureAccess, FeatureId, ItemAccess } from '@deveye/types';

import { assertDeclaredFeature, declaredItemId, itemRefusal } from './_access';
import { FeatureError, type FeatureContext } from './_define';
import { assertAccessDeclared } from './_permissions';

/**
 * La garde déclarée d'une commande, avec un rôle en lecture sur Bases et deux
 * surcharges : la base 1 confiée en écriture, la base 2 passée en lecture seule
 * à un rôle qui écrirait sinon.
 */
function guards(role: FeatureAccess, overrides: Record<string, ItemAccess>, extras: string[] = []) {
    const feature = 'database' as FeatureId;
    return {
        feature,
        assertItem: async (_f: FeatureId, itemId: string, level: FeatureAccess = 'read') => {
            const refusal = itemRefusal(overrides[itemId], role, level);
            if (refusal) throw new FeatureError('forbidden', refusal);
        },
        assertFeature: (_f: FeatureId, level: FeatureAccess = 'read') => {
            if (level === 'write' && role !== 'write') throw new FeatureError('forbidden', 'rôle');
        },
        holdsExtra: (_f: FeatureId, key: string) => extras.includes(key)
    };
}

describe('assertDeclaredFeature', () => {
    const write = { feature: 'database' as FeatureId, level: 'write' as const };

    it('refuse un geste sans élément au rôle en lecture, même confié sur une base', async () => {
        await assert.rejects(assertDeclaredFeature(write, undefined, guards('read', { '1': 'write' })), FeatureError);
    });

    it("ouvre l'écriture sur la base confiée", async () => {
        await assertDeclaredFeature(write, '1', guards('read', { '1': 'write' }));
    });

    it('la refuse sur une autre base', async () => {
        await assert.rejects(assertDeclaredFeature(write, '3', guards('read', { '1': 'write' })), FeatureError);
    });

    it('la refuse sur une base passée en lecture seule pour un rôle qui écrit', async () => {
        await assert.rejects(assertDeclaredFeature(write, '2', guards('write', { '2': 'read' })), FeatureError);
    });

    it("exige du rôle une permission propre quand aucun élément n'est nommé", async () => {
        const spec = { feature: 'database' as FeatureId, extras: ['manage'] };
        await assert.rejects(assertDeclaredFeature(spec, undefined, guards('write', {})), FeatureError);
        await assertDeclaredFeature(spec, undefined, guards('write', {}, ['manage']));
    });
});

describe('declaredItemId', () => {
    const ctx = {} as FeatureContext;

    it('lit le champ nommé, ou rien quand la requête ne le porte pas', async () => {
        assert.equal(await declaredItemId({ item: 'databaseId' }, ctx, { databaseId: 7 }), '7');
        assert.equal(await declaredItemId({ item: 'databaseId' }, ctx, {}), undefined);
        assert.equal(await declaredItemId(undefined, ctx, { databaseId: 7 }), undefined);
    });

    it("demande l'élément à sa fonction, et rien quand la ligne n'existe pas", async () => {
        const item = async (_ctx: FeatureContext, input: { alertId: number }) => (input.alertId === 3 ? 9 : undefined);
        assert.equal(await declaredItemId({ item }, ctx, { alertId: 3 }), '9');
        assert.equal(await declaredItemId({ item }, ctx, { alertId: 4 }), undefined);
    });
});

describe('assertAccessDeclared : access.item', () => {
    const input = { shape: { databaseId: {} } };

    it('refuse un champ que l’entrée ne porte pas', () => {
        assert.throws(
            () => assertAccessDeclared([{ command: 'x.a', input, access: { feature: 'database', item: 'id' } }]),
            /x\.a/
        );
    });

    it('refuse un élément sans fonctionnalité', () => {
        assert.throws(() => assertAccessDeclared([{ command: 'x.b', input, access: { item: 'databaseId' } }]), /x\.b/);
    });

    it('accepte un champ de l’entrée ou une fonction', () => {
        assert.doesNotThrow(() =>
            assertAccessDeclared([
                { command: 'x.c', input, access: { feature: 'database', item: 'databaseId' } },
                { command: 'x.d', input, access: { feature: 'database', item: async () => 1 } }
            ])
        );
    });
});
