import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { FeatureError, type SdkCipher } from '@deveye/types/sdk/server';

import type { FeatureKvRepo, FeatureKvRow } from '@/db/repos/featureKv';
import { createFeatureStore } from './store';

/**
 * Le FeatureStore du SDK : le mode figé sur la ligne choisit le déchiffrement
 * à la lecture ; sans cipher gardé, une ligne 'private' lève `locked` ; le
 * schéma zod produit deux erreurs typées selon le côté fautif, jamais un
 * ZodError brut.
 */

const WS = 3;
const FEATURE = 'x-storetest';

/** `feature_kv` en mémoire : un Map, et la ligne brute lisible par le test. */
function fakeKv() {
    const rows = new Map<string, FeatureKvRow>();
    const at = (ws: number, feature: string, key: string): string => `${ws}/${feature}/${key}`;
    const repo: FeatureKvRepo = {
        get: async (ws, feature, key) => rows.get(at(ws, feature, key)) ?? null,
        put: async (ws, feature, key, mode, value) => {
            rows.set(at(ws, feature, key), { workspace_id: ws, feature, k: key, mode, value, updated: 0 });
        },
        remove: async (ws, feature, key) => {
            rows.delete(at(ws, feature, key));
        },
        keys: async (ws, feature, prefix) =>
            [...rows.values()]
                .filter((r) => r.workspace_id === ws && r.feature === feature && r.k.startsWith(prefix))
                .map((r) => r.k)
                .sort()
    };
    return {
        repo,
        rowOf: (key: string): FeatureKvRow | undefined => rows.get(at(WS, FEATURE, key)),
        /** Une ligne posée par un autre chemin que le store (autre processus, autre mode). */
        seed: (key: string, mode: FeatureKvRow['mode'], value: string): void => {
            rows.set(at(WS, FEATURE, key), { workspace_id: WS, feature: FEATURE, k: key, mode, value, updated: 0 });
        }
    };
}

/**
 * Un cipher qui étiquette au lieu de chiffrer : `tag(clair)`. Le blob dit
 * ainsi quel cipher l'a produit, et les compteurs disent lequel a été sollicité.
 */
function fakeCipher(tag: string) {
    const calls = { encrypt: 0, decrypt: 0 };
    const decrypt = async (blob: string): Promise<string> => {
        calls.decrypt += 1;
        if (!blob.startsWith(`${tag}(`) || !blob.endsWith(')')) {
            throw new FeatureError('internal', `blob étranger au cipher ${tag}`);
        }
        return blob.slice(tag.length + 1, -1);
    };
    const cipher: SdkCipher = {
        encrypt: async (plain) => {
            calls.encrypt += 1;
            return `${tag}(${plain})`;
        },
        decrypt,
        tryDecrypt: (blob) => decrypt(blob).catch(() => null)
    };
    return { cipher, calls };
}

function setup(opts: { guarded: boolean } = { guarded: true }) {
    const kv = fakeKv();
    const open = fakeCipher('open');
    const guarded = fakeCipher('guarded');
    const store = createFeatureStore(kv.repo, FEATURE, WS, {
        open: open.cipher,
        guarded: opts.guarded ? guarded.cipher : null
    });
    return { store, kv, open, guarded };
}

const featureError = (code: FeatureError['code']) => ({ name: 'FeatureError', code });

describe('createFeatureStore : le mode figé sur la ligne', () => {
    it("'server' par défaut : scellé par le cipher ouvert, relu par lui", async () => {
        const { store, kv, open, guarded } = setup();
        await store.put('token', 'abc');
        assert.equal(kv.rowOf('token')?.mode, 'server');
        assert.equal(kv.rowOf('token')?.value, 'open(abc)');
        assert.equal(await store.get('token'), 'abc');
        assert.deepEqual(open.calls, { encrypt: 1, decrypt: 1 });
        assert.deepEqual(guarded.calls, { encrypt: 0, decrypt: 0 });
    });

    it("'none' : en clair sur la ligne, aucun cipher sollicité", async () => {
        const { store, kv, open, guarded } = setup();
        await store.put('meta', '{"n":1}', { encryption: 'none' });
        assert.equal(kv.rowOf('meta')?.mode, 'none');
        assert.equal(kv.rowOf('meta')?.value, '{"n":1}');
        assert.equal(await store.get('meta'), '{"n":1}');
        assert.deepEqual(open.calls, { encrypt: 0, decrypt: 0 });
        assert.deepEqual(guarded.calls, { encrypt: 0, decrypt: 0 });
    });

    it("'private' : scellé par le cipher gardé, jamais l'ouvert", async () => {
        const { store, kv, open, guarded } = setup();
        await store.put('secret', 's3cr3t', { encryption: 'private' });
        assert.equal(kv.rowOf('secret')?.mode, 'private');
        assert.equal(kv.rowOf('secret')?.value, 'guarded(s3cr3t)');
        assert.equal(await store.get('secret'), 's3cr3t');
        assert.deepEqual(guarded.calls, { encrypt: 1, decrypt: 1 });
        assert.deepEqual(open.calls, { encrypt: 0, decrypt: 0 });
    });

    it("la lecture suit le mode de la ligne, pas l'intention de l'appelant", async () => {
        const { store, kv, open } = setup();
        // Une ligne écrite en clair par un autre chemin se relit sans cipher...
        kv.seed('k', 'none', 'clair');
        assert.equal(await store.get('k'), 'clair');
        assert.equal(open.calls.decrypt, 0);
        // ...et une réécriture en 'server' change le mode de la ligne avec sa valeur.
        await store.put('k', 'clair');
        assert.equal(kv.rowOf('k')?.mode, 'server');
        assert.equal(kv.rowOf('k')?.value, 'open(clair)');
        assert.equal(await store.get('k'), 'clair');
        assert.equal(open.calls.decrypt, 1);
    });

    it('clé absente : null, sans déchiffrer', async () => {
        const { store, open } = setup();
        assert.equal(await store.get('absente'), null);
        assert.equal(open.calls.decrypt, 0);
    });
});

describe('createFeatureStore : sans cipher gardé (services)', () => {
    it("lire une ligne 'private' lève locked plutôt que de rendre le blob", async () => {
        const { store, kv } = setup({ guarded: false });
        kv.seed('secret', 'private', 'guarded(s3cr3t)');
        await assert.rejects(store.get('secret'), featureError('locked'));
    });

    it("écrire en 'private' lève locked aussi, et rien n'est écrit", async () => {
        // Le type sessionless l'interdit déjà ; la garde tient aussi au runtime.
        const { store, kv } = setup({ guarded: false });
        await assert.rejects(store.put('secret', 'x', { encryption: 'private' }), featureError('locked'));
        assert.equal(kv.rowOf('secret'), undefined);
    });

    it("'server' et 'none' restent lisibles sans session", async () => {
        const { store } = setup({ guarded: false });
        await store.put('a', '1');
        await store.put('b', '2', { encryption: 'none' });
        assert.equal(await store.get('a'), '1');
        assert.equal(await store.get('b'), '2');
    });
});

describe('createFeatureStore : putJson / getJson', () => {
    const schema = z.object({ n: z.number() });

    it("aller-retour sous le schéma, le mode s'applique au JSON sérialisé", async () => {
        const { store, kv } = setup();
        await store.putJson('cfg', schema, { n: 1 }, { encryption: 'none' });
        assert.equal(kv.rowOf('cfg')?.value, '{"n":1}');
        assert.deepEqual(await store.getJson('cfg', schema), { n: 1 });
        await store.putJson('cfg2', schema, { n: 2 });
        assert.equal(kv.rowOf('cfg2')?.value, 'open({"n":2})');
        assert.deepEqual(await store.getJson('cfg2', schema), { n: 2 });
    });

    it("une valeur hors schéma à l'écriture : validation, et rien n'est écrit", async () => {
        const { store, kv } = setup();
        // `putJson` lève AVANT de rendre sa promesse (le parse précède l'appel
        // async) : la fonction enveloppante rend l'assertion indifférente à ce détail.
        await assert.rejects(
            async () => store.putJson('cfg', schema, { n: 'un' } as never),
            featureError('validation')
        );
        assert.equal(kv.rowOf('cfg'), undefined);
    });

    it('une ligne hors schéma à la lecture : internal (le schéma ne la décrit plus)', async () => {
        const { store, kv } = setup();
        kv.seed('cfg', 'none', '{"n":"un"}');
        await assert.rejects(store.getJson('cfg', schema), featureError('internal'));
    });

    it("le message nomme la clé, et l'erreur n'est jamais un ZodError brut", async () => {
        const { store, kv } = setup();
        kv.seed('cfg', 'none', '{"n":"un"}');
        await assert.rejects(store.getJson('cfg', schema), (e: unknown) => {
            assert.ok(e instanceof FeatureError);
            assert.match(e.message, /« cfg »/);
            return true;
        });
    });

    it('clé absente : null', async () => {
        const { store } = setup();
        assert.equal(await store.getJson('absente', schema), null);
    });
});

describe('createFeatureStore : remove / keys', () => {
    it('keys filtre par préfixe, sans préfixe liste tout ; remove retire', async () => {
        const { store } = setup();
        await store.put('job:1', 'a', { encryption: 'none' });
        await store.put('job:2', 'b', { encryption: 'none' });
        await store.put('meta', 'c', { encryption: 'none' });
        assert.deepEqual(await store.keys('job:'), ['job:1', 'job:2']);
        assert.deepEqual(await store.keys(), ['job:1', 'job:2', 'meta']);
        await store.remove('job:1');
        assert.deepEqual(await store.keys('job:'), ['job:2']);
    });
});
