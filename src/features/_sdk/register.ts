import { isExternalFeatureId, registerExternalFeature, type LiveTopic } from '@deveye/types';
import { externalDescriptorOf, validateManifest, type FeatureManifest } from '@deveye/types/sdk';
import type {
    FeatureAgentHooks,
    FeatureServer,
    FeatureService,
    SdkCipher,
    SdkDnsRecord,
    SdkDomain,
    SdkDomainProbe,
    SdkMovePlan,
    SdkQueryable
} from '@deveye/types/sdk/server';
import { FeatureError } from '@deveye/types/sdk/server';
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';

import type { Database } from '@/db';
import type { Queryable } from '@/db/pool';
import { defineFeature, type FeatureDefinition } from '@/features/_define';
import type { SdkProviders, SdkPublicApp, SdkPublicHandler, SdkPublicRouteOptions } from '@deveye/types/sdk/server';
import { createSdkContext } from './context';
import { createDomainsContext, type DomainsHost } from './domains';
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
 * Enregistre les modules installés, une fois, au chargement du registre :
 * toute violation lève et empêche le démarrage.
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
        // Projeter suppose que l'app sache où vit un élément (`items`) :
        // refusé au boot plutôt que découvert à l'écran.
        if (manifest.shareTier !== 'never' && !mod.server.items) {
            throw new Error(`Module « ${manifest.id} » : shareTier '${manifest.shareTier}' exige server.items`);
        }
        // Les deux moitiés vont ensemble : l'onglet sans la sonde ne vérifierait
        // rien, la sonde sans l'onglet ne serait jamais appelée.
        if (Boolean(manifest.domains) !== Boolean(mod.server.domains)) {
            throw new Error(`Module « ${manifest.id} » : manifest.domains et server.domains vont ensemble`);
        }
        if (manifest.accountOnly) {
            const scoped = mod.server.features.find((def) => def.access?.scope !== 'account');
            if (scoped) {
                throw new Error(
                    `Module « ${manifest.id} » : accountOnly exige access.scope 'account' (${scoped.command})`
                );
            }
        }
        if (manifest.accountEntry?.signupHint) {
            const other = MODULES.find((m) => m.manifest.accountEntry?.signupHint);
            if (other) {
                throw new Error(
                    `Modules « ${other.manifest.id} » et « ${manifest.id} » : un seul peut déclarer signupHint`
                );
            }
        }
        // Une native migrée a déjà son descripteur dans le registre publié :
        // seuls les ids externes s'enregistrent ici.
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
 * Chaque commande est gardée par le droit de sa feature (`read` par défaut) et
 * par ses permissions propres, toutes deux appliquées par le dispatcheur : les
 * déclarer plutôt que les éprouver ici est ce qui permet à la surcharge d'un
 * élément de mordre, `ctx.items.assert` tranchant pour l'élément visé. Une
 * commande qui n'en vise aucun garde donc sa vérification dans son handler.
 */
export function moduleFeatureHandlers(): FeatureDefinition<string, never, never>[] {
    return MODULES.flatMap((mod) =>
        mod.server.features.map((def) =>
            defineFeature({
                command: def.command,
                input: def.input as never,
                output: def.output as never,
                access: {
                    feature: mod.manifest.id,
                    level: def.access?.level ?? 'read',
                    ...(def.access?.extras ? { extras: def.access.extras } : {}),
                    ...(def.access?.scope ? { scope: def.access.scope } : {})
                },
                // Un booléen bat le sujet du module ; une liste nomme les sujets,
                // que `buildTopicIndex` valide au boot.
                mutates: def.mutates === true ? true : def.mutates ? (def.mutates as readonly LiveTopic[]) : undefined,
                handler: async (ctx, input) => {
                    // L'administrateur global, en plus du droit de feature :
                    // les gestes de flotte (appairer, révoquer, supprimer).
                    if (def.access?.admin) ctx.assertAdmin();
                    const sdkCtx = createSdkContext(ctx, mod.manifest, mod.repoFor(ctx.db), PROVIDERS);
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
 * repo, pour le partage et le routage de notification. `undefined` pour une
 * feature sans `items`.
 */
export function moduleItems(
    featureId: string,
    db: Database
):
    | {
          homeOf(itemId: string, workspaceId: number): Promise<number | null>;
          labelOf(cipher: SdkCipher, itemId: string, workspaceId: number): Promise<string | null>;
          /** Vrai par défaut : seule une feature à palier par élément répond parfois non. */
          shareable(itemId: string, workspaceId: number): Promise<boolean>;
          /** `undefined` quand la fonctionnalité ne sait pas déplacer ses éléments. */
          move?: {
              plan(itemId: string, from: number, to: number): Promise<SdkMovePlan>;
              /** `q` est transactionnel : le module y écrit, l'app y fait son ménage. */
              apply(
                  q: Queryable,
                  itemId: string,
                  from: number,
                  to: number,
                  ciphers: { from: SdkCipher; to: SdkCipher }
              ): Promise<void>;
          };
      }
    | undefined {
    const mod = BY_ID.get(featureId);
    const items = mod?.server.items;
    if (!mod || !items) return undefined;
    const move = items.move;
    return {
        homeOf: (itemId, workspaceId) => items.homeOf(mod.repoFor(db), itemId, workspaceId),
        labelOf: (cipher, itemId, workspaceId) => items.labelOf(mod.repoFor(db), cipher, itemId, workspaceId),
        shareable: (itemId, workspaceId) =>
            items.shareable ? items.shareable(mod.repoFor(db), itemId, workspaceId) : Promise.resolve(true),
        move: move && {
            plan: (itemId, from, to) =>
                move.plan({
                    // Le pool : planifier n'écrit rien, et le geste n'a pas
                    // encore ouvert de transaction.
                    q: sdkQueryable(db.queryable),
                    repo: mod.repoFor(db),
                    itemId,
                    fromWorkspaceId: from,
                    toWorkspaceId: to
                }),
            apply: (q, itemId, from, to, ciphers) =>
                move.apply({
                    // La transaction, et non `db.queryable` : le repo du module
                    // reste sur le pool, il ne sert qu'à lire.
                    q: sdkQueryable(q),
                    repo: mod.repoFor(db),
                    itemId,
                    fromWorkspaceId: from,
                    toWorkspaceId: to,
                    ciphers
                })
        }
    };
}

/**
 * Les crochets `domains` d'un module, liés à son repo. `undefined` pour une
 * fonctionnalité qui ne gère pas de domaines.
 */
export function moduleDomains(
    featureId: string,
    host: DomainsHost
):
    | {
          manifest: FeatureManifest;
          records(domain: SdkDomain): Promise<readonly SdkDnsRecord[]>;
          probe(domain: SdkDomain): Promise<SdkDomainProbe>;
          useCount(workspaceId: number): Promise<ReadonlyMap<number, number>>;
          onRemoved(domain: SdkDomain): Promise<void>;
      }
    | undefined {
    const mod = BY_ID.get(featureId);
    const hooks = mod?.server.domains;
    if (!mod || !hooks || !mod.manifest.domains) return undefined;
    const ctx = createDomainsContext(host, mod.manifest, mod.repoFor(host.db));
    return {
        manifest: mod.manifest,
        records: (domain) => hooks.records(ctx, domain),
        probe: (domain) => hooks.probe(ctx, domain),
        useCount: (workspaceId) => hooks.useCount?.(ctx, workspaceId) ?? Promise.resolve(new Map()),
        onRemoved: (domain) => hooks.onRemoved?.(ctx, domain) ?? Promise.resolve()
    };
}

/** Les fonctionnalités installées qui gèrent des domaines. */
export function moduleDomainFeatures(): string[] {
    return MODULES.filter((mod) => mod.manifest.domains && mod.server.domains).map((mod) => mod.manifest.id);
}

/** Un module dont les éléments changent d'espace : l'entrée `move` de ses `items`. */
export function isModuleMovable(featureId: string): boolean {
    return BY_ID.get(featureId)?.server.items?.move !== undefined;
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
 * Les services créés : hooks agent et contrats offerts se lisent dessus à la
 * demande, jamais à la construction, pour que l'ordre de boot ne compte pas.
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
 * L'agrégat des hooks agent des modules qui déclarent la capacité 'agents'.
 * Chaque hook est isolé : un module qui trébuche sur une trame ne prive ni
 * les autres ni la couche socket.
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
 * @deveye/types/sdk/providers) : `undefined` quand personne n'offre la clé,
 * à l'appelant de dégrader proprement. Une clé n'a qu'un offreur possible.
 */
export function moduleProvider<T>(key: string): T | undefined {
    for (const s of SERVICES) {
        const value = s.service.providers?.[key];
        if (value !== undefined) return value as T;
    }
    return undefined;
}

/**
 * Valide les `extras` d'une liste de grants contre les manifests installés :
 * chaque clé doit exister dans les `extraPermissions` du manifest, avec une
 * valeur du bon type. Une feature externe inconnue (module retiré) passe telle
 * quelle : rejeter casserait l'édition d'un rôle qui n'y touche pas.
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

/** Les chemins publics déclarés par les modules, pour le délégateur CORS de l'app. */
const PUBLIC_PATHS = new Set<string>();
/**
 * Ceux qui portent un paramètre. La comparaison exacte est aveugle à
 * `/rdv/:ref`, et le délégateur CORS retomberait alors sur l'origine de l'app
 * avec les cookies : une panne invisible en local, et visible seulement depuis
 * un site tiers.
 */
const PUBLIC_PATTERNS: RegExp[] = [];

export function isModulePublicPath(url: string): boolean {
    const end = url.indexOf('?');
    const path = end === -1 ? url : url.slice(0, end);
    return PUBLIC_PATHS.has(path) || PUBLIC_PATTERNS.some((re) => re.test(path));
}

/**
 * Monte les routes publiques des modules (capacité `'routes.public'`) sur un
 * écouteur : l'app elle-même, et la surface publique quand elle existe. Sans
 * la capacité déclarée, refus : ouvrir une porte ne se fait pas en douce. Pas
 * de session, journal silencieux, plafond de débit par route à la demande.
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
            // Une route qui n'a de sens que depuis l'origine de l'app (ticket,
            // retour OAuth) ne s'ouvre pas sur la surface publique.
            if ((opts.exposure ?? 'everywhere') === 'app' && listener === 'public') return;
            if (/[:*]/.test(path)) {
                PUBLIC_PATTERNS.push(
                    new RegExp(
                        `^${path
                            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                            .replace(/:[A-Za-z0-9_]+/g, '[^/]+')
                            .replace(/\*/g, '.*')}$`
                    )
                );
            } else {
                PUBLIC_PATHS.add(path);
            }
            const route: RouteShorthandOptions = { logLevel: 'silent' };
            route.config = {
                ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
                ...(opts.rawBody ? { rawBody: true } : {})
            };
            // Deux branches plutôt qu'un `app[method]` : l'union des deux
            // signatures ne se résout pas (la surcharge WebSocket de `get`
            // prend le dessus).
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

declare module 'fastify' {
    interface FastifyContextConfig {
        rawBody?: boolean;
    }
    interface FastifyRequest {
        rawBody?: string;
    }
}

/**
 * À appeler par l'analyseur JSON de chaque écouteur : garde le corps tel que
 * reçu sur les routes qui le demandent (`SdkPublicRouteOptions.rawBody`), ce
 * sur quoi se calcule la signature d'un webhook.
 */
export function keepRawBody(req: FastifyRequest, body: string): void {
    if (req.routeOptions.config.rawBody) req.rawBody = body;
}

/**
 * Les sujets live que les modules installés peuvent battre : leur id et leurs
 * sujets secondaires (`manifest.topics`). Lu à l'appel par `_topics.ts`, jamais
 * au chargement, pour que l'ordre des imports ne compte pas.
 */
export function moduleTopics(): readonly string[] {
    return MODULES.flatMap((m) => [m.manifest.id, ...(m.manifest.topics ?? []).map((t) => t.id)]);
}
