import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UptimeServiceRow } from '../contracts/domain';
import type { SdkCipher, SdkPublicApp, SdkPublicHandler, SdkPublicReply } from '@deveye/types/sdk/server';

import { DEPLOY_HOOK_PATH, deployHookHash, registerDeployHook } from './deploySources';
import type { UptimeRepo } from './repo';

/** La route enregistrée, et ce qu'elle a répondu. */
function routeOf(rows: UptimeServiceRow[]) {
    let handler: SdkPublicHandler | null = null;
    const app = {
        post: (path: string, _opts: unknown, h: SdkPublicHandler) => {
            assert.equal(path, `${DEPLOY_HOOK_PATH}/:token`);
            handler = h;
        }
    } as unknown as SdkPublicApp;
    const repo = {
        services: {
            findByDeployHook: async (hash: string) => rows.find((r) => r.deploy_hook_hash === hash) ?? null,
            markDeployHookCalled: async (id: number, at: number) => {
                const r = rows.find((x) => x.id === id);
                if (r) r.deploy_hook_at = at;
            }
        }
    } as unknown as UptimeRepo;
    const probed: { id: number; hookAt: number | null; readFiles?: boolean }[] = [];
    // Le contenu des lignes est du JSON en clair : un codec à l'identité suffit.
    const cipher = { tryDecrypt: async (blob: string) => blob } as unknown as SdkCipher;
    registerDeployHook(
        app,
        { repo, cipherFor: () => cipher },
        {
            runOne: async (row, opts) => {
                probed.push({ id: row.id, hookAt: row.deploy_hook_at, readFiles: opts?.readFiles });
            }
        }
    );
    async function call(token: string): Promise<number> {
        let status = 200;
        const reply: SdkPublicReply = {
            header: () => reply,
            code: (s) => {
                status = s;
                return reply;
            },
            send: () => undefined
        };
        await handler!({ headers: {}, body: undefined, params: { token }, ip: '203.0.113.1' }, reply);
        return status;
    }
    return { call, probed };
}

const TOKEN = 'a'.repeat(32);

function service(over: Partial<UptimeServiceRow> & { deployAccept?: boolean } = {}): UptimeServiceRow {
    const { deployAccept = true, ...row } = over;
    return {
        id: 1,
        workspace_id: 1,
        content: JSON.stringify({ name: 'Site', url: 'https://exemple.fr/', keyword: null, paths: [], deployAccept }),
        integrity_interval_seconds: 900,
        deploy_hook_hash: deployHookHash(TOKEN),
        deploy_hook_at: null,
        enabled: 1,
        ...row
    } as UptimeServiceRow;
}

describe('l’adresse d’appel', () => {
    it('note l’appel et relit les fichiers sur-le-champ, une fois par minute au plus', async () => {
        const rows = [service()];
        const { call, probed } = routeOf(rows);
        assert.equal(await call(TOKEN), 204);
        assert.notEqual(rows[0].deploy_hook_at, null);
        assert.deepEqual(probed, [{ id: 1, hookAt: rows[0].deploy_hook_at, readFiles: true }]);

        // Une CI qui relance aussitôt : l'heure avance, la lecture ne repart pas.
        assert.equal(await call(TOKEN), 204);
        assert.equal(probed.length, 1);
    });

    it('ne répond qu’à un jeton connu', async () => {
        const { call, probed } = routeOf([service()]);
        assert.equal(await call('b'.repeat(32)), 404);
        assert.equal(await call('court'), 404);
        assert.equal(probed.length, 0);
    });

    it('l’option ou l’acceptation éteinte, répond sans rien relire : la CI ne casse pas', async () => {
        for (const over of [{ integrity_interval_seconds: null }, { deployAccept: false }]) {
            const rows = [service(over)];
            const { call, probed } = routeOf(rows);
            assert.equal(await call(TOKEN), 204);
            assert.notEqual(rows[0].deploy_hook_at, null);
            assert.equal(probed.length, 0);
        }
    });

    it('un service en pause garde l’heure de l’appel sans être sondé', async () => {
        const rows = [service({ enabled: 0 })];
        const { call, probed } = routeOf(rows);
        assert.equal(await call(TOKEN), 204);
        assert.notEqual(rows[0].deploy_hook_at, null);
        assert.equal(probed.length, 0);
    });
});
