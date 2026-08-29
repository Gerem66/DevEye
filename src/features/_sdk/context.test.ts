import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from 'pino';
import type { FeatureId } from '@deveye/types';
import type { FeatureManifest, NativeCapability } from '@deveye/types/sdk';

import type { FeatureAuditEntry, FeatureContext } from '@/features/_define';
import { createSdkContext } from './context';
import type { SdkProviders } from '@deveye/types/sdk/server';

/** Aucun contrat offert : ce que ces tests n'exercent pas. */
const NO_PROVIDERS: SdkProviders = { get: () => undefined };

/**
 * L'adaptateur du contexte natif en contexte SDK : la projection (rien de plus
 * que le contrat), la résolution des extras contre les specs du manifest, et
 * le transport du socket gardé deux fois (capacité, puis présence du socket).
 */

function manifest(opts: { id?: FeatureId; caps?: readonly NativeCapability[] } = {}): FeatureManifest {
    return {
        id: opts.id ?? 'x-contexttest',
        label: 'Contexte',
        description: 'Module de test du contexte SDK.',
        icon: 'test',
        category: 'daily',
        notifies: false,
        hasItems: false,
        shareTier: 'never',
        resources: [],
        commands: [],
        nativeCapabilities: opts.caps ?? [],
        extraPermissions: [
            { key: 'manage', label: 'Gérer', description: 'Peut gérer.', type: 'toggle' },
            {
                key: 'scope',
                label: 'Portée',
                description: 'Ce que le membre voit.',
                type: 'choice',
                options: [
                    { value: 'own', label: 'Les siens' },
                    { value: 'team', label: "L'équipe" },
                    { value: 'all', label: 'Tout' }
                ],
                default: 'own',
                ownerValue: 'all'
            }
        ]
    };
}

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

interface Fake {
    isOwner?: boolean;
    extras?: Record<string, boolean | string>;
    canWrite?: boolean;
    monitor?: object;
}

/** Le contexte natif, réduit à ce que l'adaptateur lit ; le reste n'existe pas. */
function fakeCtx(over: Fake = {}) {
    const audits: FeatureAuditEntry[] = [];
    const canFeatureCalls: unknown[][] = [];
    const extrasForCalls: string[] = [];
    const open = { tier: 'open' };
    const secure = { tier: 'guarded', open };
    const ctx = {
        db: { featureKv: {} },
        secure,
        userId: 7,
        workspaceId: 3,
        workspace: { id: 3, kind: 'shared', ownerUserId: 1, name: 'Équipe', features: [] },
        isOwner: over.isOwner ?? false,
        isAdmin: false,
        canFeature: (feature: string, level?: string) => {
            canFeatureCalls.push([feature, level]);
            return over.canWrite ?? false;
        },
        extrasFor: (feature: string) => {
            extrasForCalls.push(feature);
            return over.extras ?? {};
        },
        audit: (entry: FeatureAuditEntry) => {
            audits.push(entry);
        },
        logger,
        requestId: 'req-1',
        monitor: over.monitor
    } as unknown as FeatureContext;
    return { ctx, audits, canFeatureCalls, extrasForCalls, secure, open };
}

const forbidden = { name: 'FeatureError', code: 'forbidden' };

describe('createSdkContext : la projection', () => {
    it('ne laisse passer que le contrat : identité, espace sans propriétaire, droits résolus', () => {
        const repo = { name: 'repo' };
        const f = fakeCtx({ canWrite: true });
        const sdk = createSdkContext(f.ctx, manifest(), repo, NO_PROVIDERS);
        assert.equal(sdk.userId, 7);
        assert.equal(sdk.workspaceId, 3);
        assert.deepEqual(sdk.workspace, { id: 3, kind: 'shared', name: 'Équipe' });
        assert.equal(sdk.isOwner, false);
        assert.equal(sdk.canWrite, true);
        assert.deepEqual(f.canFeatureCalls, [['x-contexttest', 'write']]);
        assert.deepEqual(f.extrasForCalls, ['x-contexttest']);
        assert.equal(sdk.repo, repo);
        assert.equal(sdk.logger, logger);
        assert.equal(sdk.requestId, 'req-1');
    });

    it("cipher() est l'étage ouvert, cipher('private') l'étage gardé", () => {
        const f = fakeCtx();
        const sdk = createSdkContext(f.ctx, manifest(), null, NO_PROVIDERS);
        assert.equal(sdk.cipher(), f.open);
        assert.equal(sdk.cipher('server'), f.open);
        assert.equal(sdk.cipher('private'), f.secure);
    });

    it("audit transmet l'entrée telle quelle, metadata rabattu sur null", () => {
        const f = fakeCtx();
        const sdk = createSdkContext(f.ctx, manifest(), null, NO_PROVIDERS);
        sdk.audit({ action: 'x.do', description: 'fait' });
        sdk.audit({ action: 'x.warn', description: 'alerte', level: 'warning', metadata: { n: 1 } });
        assert.deepEqual(f.audits, [
            { action: 'x.do', description: 'fait', level: undefined, metadata: null },
            { action: 'x.warn', description: 'alerte', level: 'warning', metadata: { n: 1 } }
        ]);
    });
});

describe('createSdkContext : canExtra (toggle)', () => {
    const can = (over: Fake, key: string): boolean =>
        createSdkContext(fakeCtx(over).ctx, manifest(), null, NO_PROVIDERS).canExtra(key);

    it('une clé inconnue du manifest : faux, même accordée', () => {
        assert.equal(can({ extras: { ghost: true } }, 'ghost'), false);
    });

    it("une clé de type choix : faux, canExtra n'est pas son lecteur", () => {
        assert.equal(can({ extras: { scope: true } }, 'scope'), false);
    });

    it('absente du grant : faux (fermé par défaut)', () => {
        assert.equal(can({}, 'manage'), false);
    });

    it('accordée à true : vrai', () => {
        assert.equal(can({ extras: { manage: true } }, 'manage'), true);
    });

    it('accordée autrement que par le booléen true : faux', () => {
        assert.equal(can({ extras: { manage: 'true' } }, 'manage'), false);
        assert.equal(can({ extras: { manage: false } }, 'manage'), false);
    });

    it('le propriétaire : vrai sans grant', () => {
        assert.equal(can({ isOwner: true }, 'manage'), true);
    });
});

describe('createSdkContext : extraValue (choice)', () => {
    const value = (over: Fake, key: string): string =>
        createSdkContext(fakeCtx(over).ctx, manifest(), null, NO_PROVIDERS).extraValue(key);

    it('une clé inconnue du manifest : chaîne vide', () => {
        assert.equal(value({ extras: { ghost: 'all' } }, 'ghost'), '');
    });

    it("une clé de type toggle : chaîne vide, extraValue n'est pas son lecteur", () => {
        assert.equal(value({ extras: { manage: true } }, 'manage'), '');
    });

    it('absente du grant : le défaut de la spec', () => {
        assert.equal(value({}, 'scope'), 'own');
    });

    it('accordée à une option : cette option', () => {
        assert.equal(value({ extras: { scope: 'team' } }, 'scope'), 'team');
    });

    it('accordée hors des options : le défaut, jamais la valeur brute', () => {
        assert.equal(value({ extras: { scope: 'everything' } }, 'scope'), 'own');
        assert.equal(value({ extras: { scope: true } }, 'scope'), 'own');
    });

    it('le propriétaire : ownerValue, quoi que dise le grant', () => {
        assert.equal(value({ isOwner: true, extras: { scope: 'own' } }, 'scope'), 'all');
        assert.equal(value({ isOwner: true }, 'scope'), 'all');
    });
});

describe('createSdkContext : transport', () => {
    function fakeMonitor() {
        const subs: number[][] = [];
        const unsubs: number[][] = [];
        const chunks: unknown[] = [];
        const monitor = {
            subscribeSync: (ids: number[]) => {
                subs.push(ids);
            },
            unsubscribeSync: (ids: number[]) => {
                unsubs.push(ids);
            },
            sendSyncChunk: (payload: unknown) => {
                chunks.push(payload);
                return 512;
            },
            syncChunkBuffered: () => 128
        };
        return { monitor, subs, unsubs, chunks };
    }
    // La capacité 'agents' est réservée aux ids natifs (validateManifest) ;
    // l'adaptateur ne valide pas, mais autant rester dans la règle.
    const withAgents = manifest({ id: 'cloudsync', caps: ['agents'] });

    it("sans la capacité 'agents' : forbidden sur chaque méthode, socket présent ou non", () => {
        const m = fakeMonitor();
        const sdk = createSdkContext(fakeCtx({ monitor: m.monitor }).ctx, manifest(), null, NO_PROVIDERS);
        assert.throws(() => sdk.transport.subscribeSync([1]), forbidden);
        assert.throws(() => sdk.transport.unsubscribeSync([1]), forbidden);
        assert.throws(() => sdk.transport.sendSyncChunk({} as never), forbidden);
        assert.throws(() => sdk.transport.syncChunkBuffered(), forbidden);
        assert.deepEqual(m.subs, []);
    });

    it('avec la capacité mais hors socket : internal', () => {
        const sdk = createSdkContext(fakeCtx().ctx, withAgents, null, NO_PROVIDERS);
        assert.throws(() => sdk.transport.subscribeSync([1]), { name: 'FeatureError', code: 'internal' });
        assert.throws(() => sdk.transport.syncChunkBuffered(), { name: 'FeatureError', code: 'internal' });
    });

    it('avec la capacité et le socket : délègue à la part sync du monitor', () => {
        const m = fakeMonitor();
        const sdk = createSdkContext(fakeCtx({ monitor: m.monitor }).ctx, withAgents, null, NO_PROVIDERS);
        sdk.transport.subscribeSync([1, 2]);
        sdk.transport.unsubscribeSync([2]);
        const chunk = { shareId: 1, seq: 0 };
        assert.equal(sdk.transport.sendSyncChunk(chunk as never), 512);
        assert.equal(sdk.transport.syncChunkBuffered(), 128);
        assert.deepEqual(m.subs, [[1, 2]]);
        assert.deepEqual(m.unsubs, [[2]]);
        assert.deepEqual(m.chunks, [chunk]);
    });
});
