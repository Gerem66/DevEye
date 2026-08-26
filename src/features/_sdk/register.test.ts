import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { FeatureId } from '@deveye/types';
import type { FeatureManifest } from '@deveye/types/sdk';
import {
    defineSdkFeature,
    type FeatureServer,
    type FeatureServiceDeps,
    type SdkFeatureContext
} from '@deveye/types/sdk/server';

import type { FeatureContext } from '@/features/_define';
import {
    createModuleServices,
    moduleAgentHooks,
    moduleFeatureHandlers,
    moduleManifest,
    moduleManifests,
    moduleProvider,
    registerModules
} from './register';
import type { ModuleServiceHost } from './service';

/**
 * L'assemblage des modules : sentinelles d'enregistrement, projection des
 * commandes en définitions natives (extras appliqués par l'enveloppe), et les
 * regards transverses sur les services (hooks agent isolés, providers).
 *
 * Le registre est un état de module (MODULES / SERVICES, sans remise à zéro) :
 * tout s'enregistre UNE fois en tête de fichier, avec des ids propres à ce
 * fichier, et chaque test lit sans écrire ; l'ordre des tests ne compte pas.
 * Le cas « deux modules offrent le même provider » fait avorter
 * `createModuleServices` à mi-course : il vit dans `register.providers.test.ts`,
 * donc dans son propre processus.
 *
 * La capacité 'agents' est réservée aux ids natifs (validateManifest) : les
 * modules à hooks empruntent des ids de l'enum. Rien d'autre n'est enregistré
 * dans ce processus.
 */

type Extra = Partial<Pick<FeatureManifest, 'nativeCapabilities' | 'extraPermissions'>>;

function manifest(id: FeatureId, extra: Extra = {}): FeatureManifest {
    return {
        id,
        label: 'Test',
        description: 'Module de test du registre.',
        icon: 'test',
        category: 'daily',
        notifies: false,
        hasItems: false,
        shareTier: 'never',
        resources: [],
        commands: [],
        ...extra
    };
}

const errors: { obj: Record<string, unknown>; msg?: string }[] = [];
const logger = {
    debug() {},
    info() {},
    warn() {},
    error(obj: unknown, msg?: string) {
        errors.push({ obj: obj as Record<string, unknown>, msg });
    }
} as unknown as Logger;
const host = {
    db: { queryable: {}, featureKv: {} },
    crypt: {},
    audit: { record() {} },
    logger
} as unknown as ModuleServiceHost;

type HookCall = [hook: string, deviceId: string, payload?: unknown];
const weatherCalls: HookCall[] = [];
const osintCalls: HookCall[] = [];
/** Le module SANS la capacité : ses hooks ne doivent jamais être appelés. */
const externalCalls: HookCall[] = [];

const ALPHA = { kind: 'alpha' };

/** Le module qui trébuche : un hook qui lève, un qui rejette, un qui marche. */
const weather: FeatureServer = {
    features: [],
    createService: () => ({
        start() {},
        stop() {},
        agentHooks: {
            onAgentConnect: () => {
                throw new Error('weather trébuche');
            },
            onAgentOffline: async () => {
                throw new Error('weather trébuche, plus tard');
            },
            onSyncChanged: (deviceId, payload) => {
                weatherCalls.push(['onSyncChanged', deviceId, payload]);
            }
        },
        providers: { alpha: ALPHA }
    })
};

/** Le voisin sain : il doit recevoir chaque trame quoi qu'il arrive à Météo. */
const osint: FeatureServer = {
    features: [],
    createService: () => ({
        start() {},
        stop() {},
        agentHooks: {
            onAgentConnect: (deviceId) => {
                osintCalls.push(['onAgentConnect', deviceId]);
            },
            onAgentOffline: (deviceId) => {
                osintCalls.push(['onAgentOffline', deviceId]);
            },
            onSyncChanged: (deviceId, payload) => {
                osintCalls.push(['onSyncChanged', deviceId, payload]);
            }
        },
        providers: { beta: 'beta-osint' }
    })
};

const REPO = { table: 'ft_sdkregister_items' };
let createRepoCalls = 0;
let externalDeps: FeatureServiceDeps | null = null;
const handled: SdkFeatureContext[] = [];
const output = z.object({ ok: z.boolean() });

/** Le module externe : deux commandes, dont une gardée par un extra. */
const external: FeatureServer = {
    createRepo: () => {
        createRepoCalls += 1;
        return REPO;
    },
    features: [
        defineSdkFeature({
            command: 'x-sdkregister.list',
            input: z.object({}),
            output,
            handler: async (ctx: SdkFeatureContext) => {
                handled.push(ctx);
                return { ok: true };
            }
        }),
        defineSdkFeature({
            command: 'x-sdkregister.purge',
            input: z.object({}),
            output,
            access: { level: 'write', extras: ['manage'] },
            mutates: true,
            handler: async (ctx: SdkFeatureContext) => {
                handled.push(ctx);
                return { ok: true };
            }
        })
    ],
    createService: (deps) => {
        externalDeps = deps;
        return {
            start() {},
            stop() {},
            agentHooks: {
                onAgentConnect: (deviceId) => {
                    externalCalls.push(['onAgentConnect', deviceId]);
                }
            }
        };
    }
};

registerModules([
    { manifest: manifest('weather', { nativeCapabilities: ['agents'] }), server: weather },
    { manifest: manifest('osint', { nativeCapabilities: ['agents'] }), server: osint },
    {
        manifest: manifest('x-sdkregister', {
            extraPermissions: [{ key: 'manage', label: 'Gérer', description: 'Peut purger.', type: 'toggle' }]
        }),
        server: external
    },
    { manifest: manifest('x-sdkbare'), server: { features: [] } }
]);
const services = createModuleServices(host);

/** Le contexte natif d'une requête, réduit à ce que l'enveloppe et l'adaptateur lisent. */
function fakeCtx(over: { isOwner?: boolean; extras?: Record<string, boolean | string> } = {}): FeatureContext {
    return {
        db: host.db,
        secure: { open: {} },
        userId: 7,
        workspaceId: 3,
        workspace: { id: 3, kind: 'shared', ownerUserId: 1, name: 'Équipe', features: [] },
        isOwner: over.isOwner ?? false,
        isAdmin: false,
        canFeature: () => true,
        extrasFor: () => over.extras ?? {},
        audit() {},
        logger,
        requestId: 'req-1'
    } as unknown as FeatureContext;
}

describe('registerModules : les sentinelles', () => {
    it('refuse un id déjà enregistré, sans toucher au registre', () => {
        const before = moduleManifests().length;
        assert.throws(
            () => registerModules([{ manifest: manifest('x-sdkbare'), server: { features: [] } }]),
            /« x-sdkbare » : déclaré deux fois/
        );
        assert.equal(moduleManifests().length, before);
    });

    it("refuse la capacité 'notify' sans notifies, et n'enregistre pas le module", () => {
        assert.throws(
            () =>
                registerModules([
                    { manifest: manifest('x-sdknotify', { nativeCapabilities: ['notify'] }), server: { features: [] } }
                ]),
            /'notify' exige notifies: true/
        );
        assert.equal(moduleManifest('x-sdknotify'), undefined);
    });

    it("valide le manifest avant tout : 'agents' est réservée aux ids natifs", () => {
        assert.throws(
            () =>
                registerModules([
                    { manifest: manifest('x-sdkagents', { nativeCapabilities: ['agents'] }), server: { features: [] } }
                ]),
            /reserved for native-id modules/
        );
        assert.equal(moduleManifest('x-sdkagents'), undefined);
    });

    it('moduleManifest retrouve un module enregistré par son id', () => {
        assert.equal(moduleManifest('x-sdkregister')?.id, 'x-sdkregister');
        assert.equal(moduleManifest('x-absent'), undefined);
    });
});

describe('moduleFeatureHandlers : la projection en définitions natives', () => {
    const byCommand = new Map(moduleFeatureHandlers().map((d) => [d.command, d]));

    it('garde chaque commande par le droit de SA feature, read par défaut, mutates normalisé', () => {
        const list = byCommand.get('x-sdkregister.list');
        assert.ok(list);
        assert.deepEqual(list.access, { feature: 'x-sdkregister', level: 'read' });
        assert.equal(list.mutates, undefined);
        const purge = byCommand.get('x-sdkregister.purge');
        assert.ok(purge);
        assert.deepEqual(purge.access, { feature: 'x-sdkregister', level: 'write' });
        assert.equal(purge.mutates, true);
    });

    it("les extras : forbidden quand l'appelant n'a pas la permission, le handler n'est pas appelé", async () => {
        const purge = byCommand.get('x-sdkregister.purge');
        assert.ok(purge);
        const seen = handled.length;
        await assert.rejects(purge.handler(fakeCtx(), {} as never), {
            name: 'FeatureError',
            code: 'forbidden',
            message: /« manage »/
        });
        assert.equal(handled.length, seen);
    });

    it('les extras : passe avec la permission accordée, et le handler voit le contexte SDK', async () => {
        const purge = byCommand.get('x-sdkregister.purge');
        assert.ok(purge);
        assert.deepEqual(await purge.handler(fakeCtx({ extras: { manage: true } }), {} as never), { ok: true });
        const ctx = handled.at(-1);
        assert.ok(ctx);
        assert.equal(ctx.canExtra('manage'), true);
        assert.equal(ctx.workspaceId, 3);
        assert.equal(ctx.repo, REPO);
    });

    it('les extras : le propriétaire passe sans grant', async () => {
        const purge = byCommand.get('x-sdkregister.purge');
        assert.ok(purge);
        assert.deepEqual(await purge.handler(fakeCtx({ isOwner: true }), {} as never), { ok: true });
    });

    it('une commande sans extras ne demande rien', async () => {
        const list = byCommand.get('x-sdkregister.list');
        assert.ok(list);
        assert.deepEqual(await list.handler(fakeCtx(), {} as never), { ok: true });
    });

    it('le repo du module est construit une fois par processus, partagé par handlers et service', () => {
        assert.equal(createRepoCalls, 1);
        assert.equal(externalDeps?.repo, REPO);
    });
});

describe('createModuleServices', () => {
    it('crée un service par module qui en déclare un, avec les deps du module', () => {
        assert.equal(services.length, 3);
        assert.ok(externalDeps);
        assert.equal(externalDeps.logger, logger);
    });
});

describe('moduleAgentHooks : les hooks isolés', () => {
    const hooks = moduleAgentHooks();
    const logged = (module: string, hook: string) =>
        errors.filter((e) => e.obj.module === module && e.obj.hook === hook);

    it("un hook qui lève n'empêche pas les autres, et se lit dans le journal", () => {
        hooks.onAgentConnect('dev-1');
        assert.ok(osintCalls.some(([hook, deviceId]) => hook === 'onAgentConnect' && deviceId === 'dev-1'));
        const [line] = logged('weather', 'onAgentConnect');
        assert.ok(line, 'le hook en échec est journalisé');
        assert.equal(line.msg, 'hook agent en échec');
        assert.ok(line.obj.err instanceof Error);
        assert.equal(line.obj.err.message, 'weather trébuche');
    });

    it('un hook asynchrone qui rejette est journalisé de même, sans rejet non géré', async () => {
        hooks.onAgentOffline('dev-2');
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(osintCalls.some(([hook, deviceId]) => hook === 'onAgentOffline' && deviceId === 'dev-2'));
        const [line] = logged('weather', 'onAgentOffline');
        assert.ok(line);
        assert.ok(line.obj.err instanceof Error);
        assert.equal(line.obj.err.message, 'weather trébuche, plus tard');
    });

    it('les hooks reçoivent le deviceId et le payload tels quels', () => {
        const payload = { shareId: 9 } as never;
        hooks.onSyncChanged('dev-3', payload);
        assert.ok(
            weatherCalls.some(
                ([hook, deviceId, p]) => hook === 'onSyncChanged' && deviceId === 'dev-3' && p === payload
            )
        );
        assert.ok(
            osintCalls.some(([hook, deviceId, p]) => hook === 'onSyncChanged' && deviceId === 'dev-3' && p === payload)
        );
    });

    it("un module sans la capacité 'agents' n'est jamais appelé, hooks déclarés ou non", () => {
        hooks.onAgentConnect('dev-4');
        assert.deepEqual(externalCalls, []);
    });

    it('un hook absent est un no-op silencieux', () => {
        const before = errors.length;
        hooks.onSyncAck('dev-5', {} as never);
        assert.equal(errors.length, before);
    });
});

describe('moduleProvider', () => {
    it('rend le contrat offert, par identité', () => {
        assert.equal(moduleProvider('alpha'), ALPHA);
        assert.equal(moduleProvider('beta'), 'beta-osint');
    });

    it("rend undefined quand aucun module ne l'offre", () => {
        assert.equal(moduleProvider('nope'), undefined);
    });
});
