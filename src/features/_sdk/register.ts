import { isExternalFeatureId, registerExternalFeature, type LiveTopic } from '@deveye/types';
import { externalDescriptorOf, validateManifest, type FeatureManifest } from '@deveye/types/sdk';
import type {
    FeatureAgentHooks,
    FeatureServer,
    FeatureService,
    SdkCipher,
    SdkQueryable
} from '@deveye/types/sdk/server';
import { FeatureError } from '@deveye/types/sdk/server';
import type { FastifyInstance, RouteShorthandOptions } from 'fastify';

import type { Database } from '@/db';
import type { Queryable } from '@/db/pool';
import { defineFeature, type FeatureDefinition } from '@/features/_define';
import type { SdkProviders, SdkPublicApp, SdkPublicHandler, SdkPublicRouteOptions } from '@deveye/types/sdk/server';
import { createSdkContext } from './context';
import { createServiceDeps, type ModuleServiceHost } from './service';

/**
 * L'assemblage des modules installés : validation des manifests, projection de
 * leurs définitions SDK en définitions natives (que le dispatcheur traite sans
 * savoir qu'un module existe), et distribution vers les points d'accueil
 * (registre de commandes, migrations, services, écrans).
 *
 * La liste vient du fichier GÉNÉRÉ `_generated/installed.ts` (voir
 * `scripts/gen-features.ts`) : figée à la compilation, jamais à chaud.
 */
export interface InstalledFeatureModule {
    manifest: FeatureManifest;
    server: FeatureServer<unknown>;
}

interface RegisteredModule extends InstalledFeatureModule {
    /** Le repo du module, construit au premier usage puis partagé. */
    repoFor(db: Database): unknown;
}

const MODULES: RegisteredModule[] = [];
const BY_ID = new Map<string, RegisteredModule>();

/** Le `Queryable` de l'app, réduit à la surface promise au SDK. */
function sdkQueryable(q: Queryable): SdkQueryable {
    return {
        query: async <T extends object>(sql: string, params?: unknown[]) => {
            const r = await q.query<never>(sql, params);
            return r.rows as T[];
        },
        execute: async (sql, params) => {
            const r = await q.query(sql, params);
            return { affectedRows: r.rowCount, insertId: r.insertId };
        }
    };
}

/**
 * Enregistre les modules installés. Appelée une fois, au chargement du
 * registre : toute violation lève et empêche le démarrage, comme les
 * sentinelles historiques (`buildTopicIndex`, `assertAccessDeclared`).
 */
export function registerModules(installed: readonly InstalledFeatureModule[]): void {
    for (const mod of installed) {
        const { manifest } = mod;
        validateManifest(manifest);
        if (BY_ID.has(manifest.id)) {
            throw new Error(`Module « ${manifest.id} » : déclaré deux fois dans features.config.json`);
        }
        if ((manifest.nativeCapabilities ?? []).includes('notify') && !manifest.notifies) {
            throw new Error(`Module « ${manifest.id} » : la capacité 'notify' exige notifies: true`);
        }
        // Projeter suppose que l'app sache où vit un élément : sans l'entrée
        // `items`, l'onglet Partage cocherait et `share.set` répondrait
        // « introuvable ». Refusé au boot plutôt que découvert à l'écran.
        if (manifest.shareTier !== 'never' && !mod.server.items) {
            throw new Error(`Module « ${manifest.id} » : shareTier '${manifest.shareTier}' exige server.items`);
        }
        // Une native rapatriée (Météo) garde son descripteur dans le registre
        // publié : seuls les ids externes s'enregistrent ici.
        if (isExternalFeatureId(manifest.id)) registerExternalFeature(externalDescriptorOf(manifest));
        let repo: { value: unknown } | null = null;
        const registered: RegisteredModule = {
            ...mod,
            repoFor: (db) => {
                if (repo === null) {
                    repo = { value: mod.server.createRepo?.(sdkQueryable(db.queryable)) };
                }
                return repo.value;
            }
        };
        MODULES.push(registered);
        BY_ID.set(manifest.id, registered);
    }
}

/** Les manifests installés, pour les écrans et validations qui en ont besoin. */
export function moduleManifests(): readonly FeatureManifest[] {
    return MODULES.map((m) => m.manifest);
}

export function moduleManifest(featureId: string): FeatureManifest | undefined {
    return BY_ID.get(featureId)?.manifest;
}

/**
 * Les définitions natives issues des modules, prêtes pour `featureHandlers`.
 *
 * Chaque commande est gardée par le droit de SA feature (niveau déclaré,
 * `read` par défaut), puis par ses extras : le dispatcheur applique la
 * première, l'enveloppe applique les seconds, le handler ne voit que le
 * contexte SDK.
 */
export function moduleFeatureHandlers(): FeatureDefinition<string, never, never>[] {
    return MODULES.flatMap((mod) =>
        mod.server.features.map((def) =>
            defineFeature({
                command: def.command,
                input: def.input as never,
                output: def.output as never,
                access: { feature: mod.manifest.id, level: def.access?.level ?? 'read' },
                // Un booléen bat le sujet du module ; une liste nomme les
                // sujets (les siens, un secondaire du manifest, celui d'une
                // autre feature dont les écrans reflètent cette donnée) :
                // `buildTopicIndex` refuse au boot un sujet inconnu.
                mutates: def.mutates === true ? true : def.mutates ? (def.mutates as readonly LiveTopic[]) : undefined,
                handler: async (ctx, input) => {
                    const sdkCtx = createSdkContext(ctx, mod.manifest, mod.repoFor(ctx.db), PROVIDERS);
                    for (const key of def.access?.extras ?? []) {
                        if (!sdkCtx.canExtra(key)) {
                            throw new FeatureError('forbidden', `Permission « ${key} » requise`);
                        }
                    }
                    return def.handler(sdkCtx, input as never) as never;
                }
            })
        )
    ) as FeatureDefinition<string, never, never>[];
}

/** Les répertoires de migrations des modules, dans l'ordre d'installation. */
export function moduleMigrationDirs(): { id: string; dir: string }[] {
    return MODULES.flatMap((m) => (m.server.migrationsDir ? [{ id: m.manifest.id, dir: m.server.migrationsDir }] : []));
}

/**
 * Ce que l'app sait des éléments d'un module (domicile, intitulé), lié à son
 * repo : les commandes transversales de partage et de routage de notification
 * y passent avant leur `switch` natif. `undefined` pour une native non migrée
 * ou un module sans éléments.
 */
export function moduleItems(
    featureId: string,
    db: Database
):
    | {
          homeOf(itemId: number, workspaceId: number): Promise<number | null>;
          labelOf(cipher: SdkCipher, itemId: number, workspaceId: number): Promise<string | null>;
          /** Vrai par défaut : seule une feature à palier par élément répond parfois non. */
          shareable(itemId: number, workspaceId: number): Promise<boolean>;
      }
    | undefined {
    const mod = BY_ID.get(featureId);
    const items = mod?.server.items;
    if (!mod || !items) return undefined;
    return {
        homeOf: (itemId, workspaceId) => items.homeOf(mod.repoFor(db), itemId, workspaceId),
        labelOf: (cipher, itemId, workspaceId) => items.labelOf(mod.repoFor(db), cipher, itemId, workspaceId),
        shareable: (itemId, workspaceId) =>
            items.shareable ? items.shareable(mod.repoFor(db), itemId, workspaceId) : Promise.resolve(true)
    };
}

/**
 * Un module dont les éléments se projettent : `shareTier` autre que 'never'
 * ET l'entrée `items` (garantie par `registerModules`). C'est l'équivalent,
 * pour un module, d'une entrée dans `SHARE_WIRED_FEATURES`.
 */
export function isModuleShareWired(featureId: string): boolean {
    const mod = BY_ID.get(featureId);
    return mod !== undefined && mod.manifest.shareTier !== 'never' && mod.server.items !== undefined;
}

/**
 * Les services créés, gardés pour les regards transverses : les hooks agent
 * (`moduleAgentHooks`) et les contrats offerts (`moduleProvider`) se lisent
 * dessus à la demande, jamais à la construction, pour que l'ordre de boot ne
 * compte pas.
 */
const SERVICES: { manifest: FeatureManifest; service: FeatureService; logger: ModuleServiceHost['logger'] }[] = [];

/**
 * Les services d'arrière-plan des modules, créés une fois, démarrés par le
 * boot. Deux modules qui offrent le même contrat (`providers`) se refusent
 * ici : `moduleProvider` n'aurait aucun critère pour en choisir un.
 */
let servicesCreated = false;

/** Ce que les modules reçoivent : la recherche à l'appel, parmi les services créés. */
const PROVIDERS: SdkProviders = { get: <T>(key: string) => moduleProvider<T>(key) };

export function createModuleServices(host: ModuleServiceHost): FeatureService[] {
    // Une seule fois par processus : un second appel doublerait les hooks et
    // laisserait `moduleProvider` sur les premiers services.
    if (servicesCreated) throw new Error('createModuleServices : déjà appelée');
    servicesCreated = true;
    const providers = new Map<string, string>();
    return MODULES.flatMap((m) => {
        if (!m.server.createService) return [];
        const service = m.server.createService(createServiceDeps(host, m.manifest, m.repoFor(host.db), PROVIDERS));
        for (const key of Object.keys(service.providers ?? {})) {
            const other = providers.get(key);
            if (other) throw new Error(`Provider « ${key} » offert par « ${other} » et « ${m.manifest.id} »`);
            providers.set(key, m.manifest.id);
        }
        SERVICES.push({ manifest: m.manifest, service, logger: host.logger });
        return [service];
    });
}

/**
 * L'agrégat des hooks agent des modules qui déclarent la capacité 'agents' :
 * la couche socket agent appelle ceci sans savoir quels modules existent.
 * Chaque hook est isolé : un module qui trébuche sur une trame ne prive pas
 * les autres, ni la couche socket ; la trame est perdue pour lui, et ça se
 * lit dans le journal.
 */
export function moduleAgentHooks(): Required<FeatureAgentHooks> {
    const each = (hook: keyof FeatureAgentHooks, run: (hooks: FeatureAgentHooks) => void | Promise<void>): void => {
        for (const s of SERVICES) {
            if (!(s.manifest.nativeCapabilities ?? []).includes('agents')) continue;
            const failed = (err: unknown): void =>
                s.logger.error({ err, module: s.manifest.id, hook }, 'hook agent en échec');
            try {
                const out = run(s.service.agentHooks ?? {});
                if (out instanceof Promise) out.catch(failed);
            } catch (err) {
                failed(err);
            }
        }
    };
    return {
        onAgentConnect: (deviceId) => each('onAgentConnect', (h) => h.onAgentConnect?.(deviceId)),
        onAgentOffline: (deviceId) => each('onAgentOffline', (h) => h.onAgentOffline?.(deviceId)),
        onReport: (deviceId, report) => each('onReport', (h) => h.onReport?.(deviceId, report)),
        onMetricsBatch: (deviceId, snapshots) => each('onMetricsBatch', (h) => h.onMetricsBatch?.(deviceId, snapshots)),
        onIntegrity: (deviceId, integrity) => each('onIntegrity', (h) => h.onIntegrity?.(deviceId, integrity)),
        onAuthEvents: (deviceId, auth) => each('onAuthEvents', (h) => h.onAuthEvents?.(deviceId, auth)),
        onSyncChanged: (deviceId, payload) => each('onSyncChanged', (h) => h.onSyncChanged?.(deviceId, payload)),
        onSyncIndex: (deviceId, payload) => each('onSyncIndex', (h) => h.onSyncIndex?.(deviceId, payload)),
        onSyncChunk: (deviceId, payload) => each('onSyncChunk', (h) => h.onSyncChunk?.(deviceId, payload)),
        onSyncAck: (deviceId, payload) => each('onSyncAck', (h) => h.onSyncAck?.(deviceId, payload)),
        onSyncOpResult: (deviceId, payload) => each('onSyncOpResult', (h) => h.onSyncOpResult?.(deviceId, payload))
    };
}

/**
 * Le contrat nommé qu'un module offre, à l'app comme aux autres modules (voir
 * @deveye/types/sdk/providers) : recherche à l'appel, `undefined` quand
 * personne n'offre la clé, et c'est à l'appelant de dégrader proprement. Une
 * clé n'a qu'un offreur possible (sentinelle de `createModuleServices`).
 * Depuis le rapatriement de Projets, l'app n'offre plus aucun contrat
 * elle-même : tout provider vient du service d'un module.
 */
export function moduleProvider<T>(key: string): T | undefined {
    for (const s of SERVICES) {
        const value = s.service.providers?.[key];
        if (value !== undefined) return value as T;
    }
    return undefined;
}

/**
 * Valide les `extras` d'une liste de grants contre les manifests installés.
 *
 * Trois cas, trois traitements :
 *  - feature au manifest connu : chaque clé doit exister dans ses
 *    `extraPermissions`, avec une valeur du bon type (et, pour un choix, une
 *    des options) ;
 *  - feature sans manifest (native pas encore migrée) : aucun extra admis ;
 *  - feature externe INCONNUE (module retiré) : le grant passe tel quel, il
 *    est inerte tant que rien ne porte cet id, et le rejeter casserait
 *    l'édition d'un rôle qui n'y touche pas.
 */
export function validateGrantExtras(
    grants: readonly { feature: string; extras: Record<string, boolean | string> }[]
): void {
    for (const grant of grants) {
        const keys = Object.keys(grant.extras);
        if (keys.length === 0) continue;
        const manifest = BY_ID.get(grant.feature)?.manifest;
        if (!manifest) {
            if (isExternalFeatureId(grant.feature)) continue;
            throw new FeatureError('validation', `« ${grant.feature} » ne déclare aucune permission propre`);
        }
        const specs = new Map((manifest.extraPermissions ?? []).map((s) => [s.key, s]));
        for (const key of keys) {
            const spec = specs.get(key);
            if (!spec) {
                throw new FeatureError('validation', `Permission inconnue « ${key} » pour « ${grant.feature} »`);
            }
            const value = grant.extras[key];
            if (spec.type === 'toggle' && typeof value !== 'boolean') {
                throw new FeatureError('validation', `« ${key} » attend un booléen`);
            }
            if (spec.type === 'choice' && (typeof value !== 'string' || !spec.options.some((o) => o.value === value))) {
                throw new FeatureError('validation', `« ${key} » attend une des options déclarées`);
            }
        }
    }
}

/**
 * Les chemins publics que les modules ont déclarés, pour le délégateur CORS
 * de l'app : ces routes-là sont faites pour être atteintes d'ailleurs, et
 * c'est la seule chose que l'app a besoin d'en savoir.
 */
const PUBLIC_PATHS = new Set<string>();

export function isModulePublicPath(url: string): boolean {
    const end = url.indexOf('?');
    return PUBLIC_PATHS.has(end === -1 ? url : url.slice(0, end));
}

/**
 * Monte les routes publiques des modules (capacité `'routes.public'`) sur un
 * écouteur : l'app elle-même, et la surface publique quand elle existe. Le
 * module déclare les mêmes routes à chaque appel ; c'est l'écouteur qui
 * change. Un module qui offre `publicRoutes` sans déclarer la capacité est
 * refusé ici, comme une façade non déclarée le serait à l'appel : ouvrir une
 * porte ne se fait pas en douce. Pas de session, journal silencieux (ce sont
 * des balises, à la cadence des visites), plafond de débit par route quand
 * le module en demande un.
 */
export function modulePublicRoutes(app: FastifyInstance, listener: 'app' | 'public'): void {
    for (const s of SERVICES) {
        const routes = s.service.publicRoutes;
        if (!routes) continue;
        if (!(s.manifest.nativeCapabilities ?? []).includes('routes.public')) {
            throw new Error(`Module « ${s.manifest.id} » : publicRoutes sans la capacité 'routes.public'`);
        }
        const mount = (
            method: 'get' | 'post',
            path: string,
            opts: SdkPublicRouteOptions,
            handler: SdkPublicHandler
        ) => {
            // Une route qui n'a de sens que depuis l'origine de l'app (un
            // téléchargement à ticket, un retour OAuth) ne s'ouvre pas sur la
            // surface publique : ce port n'expose que ce qui doit l'être.
            if ((opts.exposure ?? 'everywhere') === 'app' && listener === 'public') return;
            PUBLIC_PATHS.add(path);
            const route: RouteShorthandOptions = { logLevel: 'silent' };
            if (opts.rateLimit) route.config = { rateLimit: opts.rateLimit };
            // Deux branches plutôt qu'un `app[method]` : l'union des deux
            // signatures ne se résout pas contre le gestionnaire (la surcharge
            // WebSocket de `get` prend le dessus). La requête et la réponse de
            // Fastify satisfont structurellement la surface promise au SDK.
            if (method === 'get') app.get(path, route, (req, reply) => handler(req, reply));
            else app.post(path, route, (req, reply) => handler(req, reply));
        };
        const surface: SdkPublicApp = {
            get: (path, opts, handler) => mount('get', path, opts, handler),
            post: (path, opts, handler) => mount('post', path, opts, handler)
        };
        routes.call(s.service, surface);
    }
}

/**
 * Les sujets live que les modules installés peuvent battre : leur id et leurs
 * sujets secondaires (`manifest.topics`). Lu par le filet de démarrage des
 * sujets (`_topics.ts`) pour valider une liste `mutates` ; lu à l'appel, jamais
 * au chargement, pour que l'ordre des imports ne compte pas.
 */
export function moduleTopics(): readonly string[] {
    return MODULES.flatMap((m) => [m.manifest.id, ...(m.manifest.topics ?? []).map((t) => t.id)]);
}
