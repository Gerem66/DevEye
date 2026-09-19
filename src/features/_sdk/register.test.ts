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
    isModuleMovable,
    moduleAgentHooks,
    moduleFeatureHandlers,
    moduleItems,
    moduleManifest,
    moduleManifests,
    moduleProvider,
    registerModules
} from './register';
import type { ModuleServiceHost } from './service';

/**
 * L'assemblage des modules : sentinelles d'enregistrement, projection des
 * commandes en définitions natives, hooks agent isolés, providers.
 *
 * Le registre est un état de module sans remise à zéro : tout s'enregistre une
 * fois en tête de fichier, chaque test lit sans écrire. Le cas « deux modules
 * offrent le même provider » avorte à mi-course : il vit dans
 * `register.providers.test.ts`. La capacité 'agents' est réservée aux ids
 * natifs : les modules à hooks empruntent des ids de l'enum.
 */

type Extra = Partial<Pick<FeatureManifest, 'nativeCapabilities' | 'extraPermissions' | 'shareTier' | 'domains'>>;

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

/**
 * Le module qui sait déplacer ses éléments : `items.move` est facultatif, et
 * c'est lui seul qui décide qu'un élément peut changer d'espace.
 */
const moveCalls: unknown[] = [];
const movable: FeatureServer<{ tag: string }> = {
    features: [],
    createRepo: () => ({ tag: 'repo' }),
    items: {
        homeOf: async () => 3,
        labelOf: async () => 'Élément',
        move: {
            plan: async (mctx) => {
                moveCalls.push(['plan', mctx.repo, mctx.itemId, mctx.fromWorkspaceId, mctx.toWorkspaceId]);
                return { blockers: [], drops: ['son historique'], rows: 12 };
            },
            apply: async (mctx) => {
                moveCalls.push(['apply', mctx.repo, mctx.itemId, mctx.fromWorkspaceId, mctx.toWorkspaceId]);
                await mctx.q.execute('UPDATE ft_x SET workspace_id = ?', [mctx.toWorkspaceId]);
            }
        }
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
    { manifest: manifest('x-sdkbare'), server: { features: [] } },
    { manifest: manifest('backup', { shareTier: 'open' }), server: movable as FeatureServer }
]);
const services = createModuleServices(host);

/** Le contexte natif d'une requête, réduit à ce que l'enveloppe et l'adaptateur lisent. */
function fakeCtx(
    over: {
        isOwner?: boolean;
        extras?: Record<string, boolean | string>;
        itemExtras?: Record<string, Record<string, boolean>>;
    } = {}
): FeatureContext {
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
        itemExtraOverrides: () => Promise.resolve(new Map(Object.entries(over.itemExtras ?? {}))),
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

    it('refuse des domaines déclarés d’un seul côté, manifest ou serveur', () => {
        const domains = { hint: 'Vos noms.', service: 'Pointez le nom ici.' };
        assert.throws(
            () => registerModules([{ manifest: manifest('x-sdkdomhalf', { domains }), server: { features: [] } }]),
            /manifest.domains et server.domains vont ensemble/
        );
        assert.throws(
            () =>
                registerModules([
                    {
                        manifest: manifest('x-sdkdomhook'),
                        server: {
                            features: [],
                            domains: {
                                records: () => Promise.resolve([]),
                                probe: () => Promise.resolve({ ok: true as const })
                            }
                        }
                    }
                ]),
            /manifest.domains et server.domains vont ensemble/
        );
        assert.equal(moduleManifest('x-sdkdomhalf'), undefined);
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
        assert.deepEqual(purge.access, { feature: 'x-sdkregister', level: 'write', extras: ['manage'] });
        assert.equal(purge.mutates, true);
    });

    it("les extras sont DÉCLARÉS et non éprouvés ici : c'est ce qui les rend surchargeables par élément", () => {
        const purge = byCommand.get('x-sdkregister.purge');
        assert.ok(purge);
        assert.deepEqual(purge.access?.extras, ['manage']);
        // Une commande qui n'en demande pas n'en déclare pas : le dispatcheur
        // n'a alors rien à éprouver.
        assert.equal(byCommand.get('x-sdkregister.list')?.access?.extras, undefined);
    });

    it('le handler reçoit le contexte SDK, ses permissions propres résolues', async () => {
        const purge = byCommand.get('x-sdkregister.purge');
        assert.ok(purge);
        assert.deepEqual(await purge.handler(fakeCtx({ extras: { manage: true } }), {} as never), { ok: true });
        const ctx = handled.at(-1);
        assert.ok(ctx);
        assert.equal(ctx.canExtra('manage'), true);
        assert.equal(ctx.workspaceId, 3);
        assert.equal(ctx.repo, REPO);
    });

    it('items.canExtra : la surcharge de l’élément prime, le droit du rôle sinon', async () => {
        const purge = byCommand.get('x-sdkregister.purge');
        assert.ok(purge);
        await purge.handler(fakeCtx({ itemExtras: { '7': { manage: true } } }), {} as never);
        const ctx = handled.at(-1);
        assert.ok(ctx);
        assert.equal(await ctx.items.canExtra('7', 'manage'), true);
        assert.equal(await ctx.items.canExtra('8', 'manage'), false);
    });

    it('le propriétaire tient toute permission propre', async () => {
        const purge = byCommand.get('x-sdkregister.purge');
        assert.ok(purge);
        assert.deepEqual(await purge.handler(fakeCtx({ isOwner: true }), {} as never), { ok: true });
        const ctx = handled.at(-1);
        assert.ok(ctx);
        assert.equal(ctx.canExtra('manage'), true);
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

describe('moduleItems : le déplacement d’un élément', () => {
    it('n’est offert que par un module qui déclare `items.move`', () => {
        assert.equal(isModuleMovable('backup'), true);
        // Sans entrée `items` du tout, et sans module : jamais déplaçable.
        assert.equal(isModuleMovable('x-sdkbare'), false);
        assert.equal(isModuleMovable('inconnu'), false);
        assert.equal(moduleItems('x-sdkbare', host.db)?.move, undefined);
    });

    it('passe au module son dépôt et les deux espaces, et rend son plan', async () => {
        const items = moduleItems('backup', host.db);
        assert.deepEqual(await items?.move?.plan('7', 3, 9), {
            blockers: [],
            drops: ['son historique'],
            rows: 12
        });
        assert.deepEqual(moveCalls.at(-1), ['plan', { tag: 'repo' }, '7', 3, 9]);
    });

    it('écrit par la transaction qu’on lui passe, pas par le pool de son dépôt', async () => {
        const written: [string, unknown[]][] = [];
        // Le `Queryable` de l'app : c'est lui que l'hôte convertit en
        // `SdkQueryable` avant de le tendre au module.
        const tx = {
            query: async (sql: string, params?: unknown[]) => {
                written.push([sql, params ?? []]);
                return { rows: [], rowCount: 1, insertId: 0 };
            }
        };
        const cipher = {
            encrypt: async (v: string) => v,
            decrypt: async (v: string) => v,
            tryDecrypt: async () => null
        };

        await moduleItems('backup', host.db)?.move?.apply(tx, '7', 3, 9, { from: cipher, to: cipher });

        assert.deepEqual(moveCalls.at(-1), ['apply', { tag: 'repo' }, '7', 3, 9]);
        assert.deepEqual(written, [['UPDATE ft_x SET workspace_id = ?', [9]]]);
    });
});
