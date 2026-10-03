import { isExternalFeatureId, registerExternalFeature, type LiveTopic } from '@deveye/types';
import { DEVEYE_ICON_PATH, externalDescriptorOf, validateManifest, type FeatureManifest } from '@deveye/types/sdk';
import type {
    FeatureAgentHooks,
    FeatureE2eEntry,
    FeatureServer,
    FeatureService,
    SdkCipher,
    SdkDnsRecord,
    SdkDomain,
    SdkDomainProbe,
    SdkMailSample,
    SdkMovePlan,
    SdkPlanPauseChange,
    SdkQueryable,
    SdkServiceHealth,
    SdkStockItem
} from '@deveye/types/sdk/server';
import {
    DOMAIN_HOST_PATTERN,
    exportItemTree,
    FeatureError,
    importItemTree,
    itemTierOf,
    itemTreeProblem,
    moduleEnvProblem,
    normaliseDomainHost,
    readModuleEnv,
    type ItemTier,
    type ItemTreeRows,
    type ModuleEnvSpec,
    type SdkCopyPlan,
    type SdkFleetDomains
} from '@deveye/types/sdk/server';
// Pour ses types seulement : c'est lui qui déclare `config.rateLimit` sur une route.
import type {} from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';

import type { Database } from '@/db';
import type { Queryable } from '@/db/pool';
import { defineFeature, type FeatureDefinition } from '@/features/_define';
import type {
    SdkProviders,
    SdkPublicApp,
    SdkPublicHandler,
    SdkPublicRouteOptions,
    SdkPublicStreamHandler,
    SdkPublicStreamRequest,
    SdkPublicStreamRouteOptions
} from '@deveye/types/sdk/server';
import { logger } from '@/logger';
import { maintenance, replyMaintenance, type MaintenanceServices } from '@/Services/maintenance';
import { touchPlanPauses, type StockSource } from '@/Services/planPauses';
import type { UsageSource } from '@/Services/quotaUsage';
import type Encryption from '@/Services/Encryption';
import type { CoverageModule } from '@/Services/accountExport/coverage';
import type { ExportModule } from '@/Services/accountExport/run';
import { serverKeysOf } from './host';
import { createSdkContext, ORIGINS } from './context';
import { createDomainsContext, sdkFleetDomains, type DomainsHost } from './domains';
import { createQuota, quotaCounter } from './quota';
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
export function sdkQueryable(q: Queryable): SdkQueryable {
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

const DEBUG_KEY = /^[a-z][a-zA-Z0-9]*$/;

/** Les échantillons de mails et les scénarios d'essai d'un module : des clés propres, uniques, et la capacité qu'ils supposent. */
function debugEntriesProblem({ manifest, server }: InstalledFeatureModule): string | null {
    const samples = server.mailSamples ?? [];
    const scenarios = server.e2e?.scenarios ?? [];
    for (const [what, keys] of [
        ['mailSamples', samples.map((m) => m.key)],
        ['e2e', scenarios.map((sc) => sc.id)]
    ] as const) {
        const bad = keys.find((k) => !DEBUG_KEY.test(k));
        if (bad !== undefined) return `${what} : clé « ${bad} » invalide`;
        const twice = keys.find((k, i) => keys.indexOf(k) !== i);
        if (twice !== undefined) return `${what} : clé « ${twice} » déclarée deux fois`;
    }
    if (samples.some((m) => m.sender === 'server') && !(manifest.nativeCapabilities ?? []).includes('accounts.mail')) {
        return "un échantillon envoyé par le serveur exige la capacité 'accounts.mail'";
    }
    if (server.e2e && scenarios.length === 0 && !server.e2e.sweep) return 'e2e déclaré vide';
    return null;
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
        // Chaque nom d'un arbre de copie finit interpolé dans du SQL, et une
        // table listée avant celle qu'elle référence s'écrirait sans son id.
        const treeProblem = mod.server.items?.copy && itemTreeProblem(mod.server.items.copy.tree);
        if (treeProblem) throw new Error(`Module « ${manifest.id} » : arbre de copie invalide (${treeProblem})`);
        const envProblem = mod.server.env && moduleEnvProblem(mod.server.env);
        if (envProblem)
            throw new Error(`Module « ${manifest.id} » : variables d'environnement mal déclarées (${envProblem})`);
        // Les deux moitiés vont ensemble : l'onglet sans la sonde ne vérifierait
        // rien, la sonde sans l'onglet ne serait jamais appelée.
        if (Boolean(manifest.domains) !== Boolean(mod.server.domains)) {
            throw new Error(`Module « ${manifest.id} » : manifest.domains et server.domains vont ensemble`);
        }
        // Toute limite doit pouvoir se compter, pour dire à un compte où il en
        // est : un stock par la liste qui décide aussi de ses pauses, un flux
        // par son compteur.
        const quotaFaults = quotaEntryProblems(manifest, mod.server.quotas);
        if (quotaFaults.length > 0) {
            throw new Error(
                `Module « ${manifest.id} » : server.quotas ne suit pas manifest.quotas (${quotaFaults.join(', ')})`
            );
        }
        if (manifest.accountOnly) {
            const scoped = mod.server.features.find((def) => def.access?.scope !== 'account');
            if (scoped) {
                throw new Error(
                    `Module « ${manifest.id} » : accountOnly exige access.scope 'account' (${scoped.command})`
                );
            }
        }
        const debugProblem = debugEntriesProblem(mod);
        if (debugProblem) throw new Error(`Module « ${manifest.id} » : ${debugProblem}`);
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

/**
 * Ce qu'un module laisse à ses défauts, en une ligne : `null` quand tout est
 * posé. Une valeur de secret n'est jamais écrite, et un secret n'a pas de
 * défaut à montrer.
 */
export function unsetEnvReport(
    spec: ModuleEnvSpec,
    source: Readonly<Record<string, string | undefined>>
): string | null {
    const { defaulted } = readModuleEnv(spec, source);
    if (defaulted.length === 0) return null;
    return defaulted
        .map((d) => {
            const value = d.value === '' ? '(vide)' : String(d.value);
            return `${d.name}=${value} (${d.reason === 'unset' ? 'non définie' : 'valeur invalide ignorée'})`;
        })
        .join(', ');
}

/**
 * Un avertissement par module dont une variable retombe sur son défaut : un
 * défaut qui devine le monde de l'exploitant (l'adresse d'un site, un dossier)
 * vise parfois à côté, et cela doit se lire au démarrage plutôt que se
 * découvrir en production.
 */
export function warnUnsetModuleEnv(source: Readonly<Record<string, string | undefined>> = process.env): void {
    for (const mod of MODULES) {
        const report = mod.server.env && unsetEnvReport(mod.server.env, source);
        if (!report) continue;
        logger.warn(
            { module: mod.manifest.id },
            `Module « ${mod.manifest.id} » : variables d'environnement non définies, défauts appliqués : ${report}`
        );
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
                    const sdkCtx = createSdkContext(
                        ctx,
                        mod.manifest,
                        mod.repoFor(ctx.db),
                        PROVIDERS,
                        mod.server.quotas
                    );
                    const out = await def.handler(sdkCtx, input as never);
                    // Une suppression a pu libérer une place : le plus ancien en
                    // pause la reprend, sans que le module ait à y penser.
                    if (def.mutates) touchPlanPauses(ctx.workspace.ownerUserId, mod.manifest.id);
                    return out as never;
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
          /** `undefined` quand la fonctionnalité ne sait pas copier ses éléments. */
          copy?: {
              plan(itemId: string, workspaceId: number): Promise<SdkCopyPlan>;
              /** `null` : l'élément n'existe plus. */
              tierOf(itemId: string): Promise<ItemTier | null>;
              /** Les lignes de l'élément, en clair. `cipher` est celui de son palier. */
              read(itemId: string, cipher: SdkCipher): Promise<ItemTreeRows>;
              /**
               * Écrit la copie dans `to` et rend son id. `q` est transactionnel.
               * `rows` vient d'un navigateur : le moteur le valide contre l'arbre.
               */
              write(
                  q: Queryable,
                  rows: ItemTreeRows,
                  into: { workspaceId: number; userId: number; cipher: SdkCipher; tier: ItemTier }
              ): Promise<string>;
          };
      }
    | undefined {
    const mod = BY_ID.get(featureId);
    const items = mod?.server.items;
    if (!mod || !items) return undefined;
    const move = items.move;
    const copy = items.copy;
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
        },
        copy: copy && {
            plan: (itemId, workspaceId) =>
                copy.plan?.({ q: sdkQueryable(db.queryable), repo: mod.repoFor(db), itemId, workspaceId }) ??
                Promise.resolve({ blockers: [], drops: [], carries: [] }),
            tierOf: (itemId) => itemTierOf(sdkQueryable(db.queryable), copy.tree, itemId),
            read: (itemId, cipher) => exportItemTree(sdkQueryable(db.queryable), copy.tree, itemId, cipher),
            write: async (q, rows, into) => {
                const to = into.workspaceId;
                const tx = sdkQueryable(q);
                const repo = mod.repoFor(db);
                // Le compte visé est le propriétaire de l'espace d'arrivée : c'est
                // son offre que la copie entame.
                const quota = createQuota(
                    db,
                    PROVIDERS,
                    mod.manifest,
                    quotaCounter(mod.server.quotas, repo),
                    async () => (await db.workspaces.findById(to))?.owner_user_id ?? null,
                    logger
                );
                await copy.admit?.({ q: tx, repo, toWorkspaceId: to, rows, quota });
                const itemId = await importItemTree(tx, copy.tree, rows, into);
                await copy.settle?.({ q: tx, repo, toWorkspaceId: to, itemId });
                return itemId;
            }
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

/** Les limites de stock d'un module, avec leur libellé, liées à son repo. */
export function moduleStocks(
    featureId: string,
    db: Database
): { fullKey: string; label: string; list(ownerWorkspaceIds: readonly number[]): Promise<readonly SdkStockItem[]> }[] {
    const mod = BY_ID.get(featureId);
    if (!mod) return [];
    return stockListers(mod).map(({ spec, list }) => ({
        fullKey: `${featureId}.${spec.key}`,
        label: spec.label,
        list: (ownerWorkspaceIds) => list(mod.repoFor(db), ownerWorkspaceIds)
    }));
}

/** Les limites de stock des modules (`stock: true`), chacune liée au repo de son module. */
export function moduleStockSources(db: Database): StockSource[] {
    return MODULES.flatMap((mod) =>
        stockListers(mod).map(({ spec, list }) => ({
            fullKey: `${mod.manifest.id}.${spec.key}`,
            featureId: mod.manifest.id,
            overLimit: async (_owner: number, ownerWorkspaceIds: readonly number[], limit: number) =>
                (await list(mod.repoFor(db), ownerWorkspaceIds)).slice(limit)
        }))
    );
}

/** Ce que compte chaque quota des modules, lié au repo de son module ; `null` pour une limite par opération. */
export function moduleUsageSources(db: Database): UsageSource[] {
    return MODULES.flatMap((mod) => {
        const count = quotaCounter(mod.server.quotas, mod.repoFor(db));
        return (mod.manifest.quotas ?? []).map((spec) => ({
            fullKey: `${mod.manifest.id}.${spec.key}`,
            kind: spec.stock ? ('stock' as const) : spec.perOperation ? ('perOperation' as const) : ('flow' as const),
            measure: async (_owner: number, owned: readonly number[]) => ({
                used: spec.perOperation ? null : await count(spec.key, owned)
            })
        }));
    });
}

/** Ce que chaque module exporte des données d'un compte, lié à son repo et à ses clés. */
export function moduleAccountExports(db: Database, crypt: Encryption): ExportModule[] {
    return MODULES.map((mod) => ({
        id: mod.manifest.id,
        label: mod.manifest.label,
        entry: mod.server.accountExport,
        repo: mod.repoFor(db),
        keys: serverKeysOf(crypt, mod.manifest.id)
    }));
}

/** La déclaration d'export de chaque module, pour le contrôle du boot. */
export function moduleExportDeclarations(): CoverageModule[] {
    return MODULES.map((mod) => ({ id: mod.manifest.id, entry: mod.server.accountExport }));
}

/** Les parties d'un export que le titulaire peut laisser de côté, `<featureId>.<clé>`. */
export function optionalExportKeys(): Set<string> {
    return new Set(
        MODULES.flatMap((mod) =>
            Object.entries(mod.server.accountExport?.files ?? {})
                .filter(([, files]) => files.optional === true)
                .map(([key]) => `${mod.manifest.id}.${key}`)
        )
    );
}

/** Les modules qui exportent et qu'une maintenance complète tient à l'arrêt : un export les manquerait. */
export function haltedExportModules(isHalted: (featureId: string) => boolean): string[] {
    return MODULES.filter((mod) => mod.server.accountExport && isHalted(mod.manifest.id)).map(
        (mod) => mod.manifest.label
    );
}

/** Les parties lourdes d'un export, mesurées sur les espaces du compte, pour la popup. */
export async function moduleExportParts(
    db: Database,
    userId: number,
    workspaceIds: readonly number[]
): Promise<{ key: string; label: string; bytes: number; optional: boolean }[]> {
    const parts: { key: string; label: string; bytes: number; optional: boolean }[] = [];
    for (const mod of MODULES) {
        for (const [key, files] of Object.entries(mod.server.accountExport?.files ?? {})) {
            const bytes = await files.bytes({
                repo: mod.repoFor(db),
                q: sdkQueryable(db.queryable),
                userId,
                workspaceIds
            });
            parts.push({
                key: `${mod.manifest.id}.${key}`,
                label: files.label,
                bytes,
                optional: files.optional === true
            });
        }
    }
    return parts;
}

/** Les stocks du manifest et leur lister : un flux n'atteint jamais le moteur des pauses. */
function stockListers(mod: RegisteredModule) {
    return (mod.manifest.quotas ?? []).flatMap((spec) => {
        const list = spec.stock ? mod.server.quotas?.[spec.key]?.list : undefined;
        return list ? [{ spec, list }] : [];
    });
}

/** Ce qui manque ou déborde dans `server.quotas` au regard du manifest. Vide : tout va. */
export function quotaEntryProblems(manifest: FeatureManifest, entries: FeatureServer['quotas']): string[] {
    const specs = manifest.quotas ?? [];
    const problems: string[] = [];
    for (const spec of specs) {
        const entry = entries?.[spec.key];
        if (spec.perOperation) {
            if (entry) problems.push(`${spec.key} : une limite par opération ne se compte pas`);
        } else if (spec.stock) {
            if (!entry?.list || entry.count) problems.push(`${spec.key} : un stock se liste`);
        } else if (!entry?.count || entry.list) {
            problems.push(`${spec.key} : un flux se compte`);
        }
    }
    for (const key of Object.keys(entries ?? {})) {
        if (!specs.some((spec) => spec.key === key)) problems.push(`${key} : non déclaré`);
    }
    return problems;
}

/**
 * Ce qu'une passe vient de mettre en pause ou de reprendre, au service du
 * module : pour ce qu'il tient ouvert. Isolé comme un hook agent, et sauté
 * tant qu'une maintenance complète tient le service à l'arrêt.
 */
export async function notifyModulePlanPause(featureId: string, change: SdkPlanPauseChange): Promise<void> {
    const s = SERVICES.find((x) => x.manifest.id === featureId);
    if (!s || s.halted || !s.service.onPlanPause) return;
    try {
        await s.service.onPlanPause(change);
    } catch (err) {
        s.logger.error({ err, module: featureId }, 'crochet de pause d’offre en échec');
    }
}

/**
 * Un compte va être supprimé : chaque service qui l'écoute termine ce qu'il
 * tient pour lui ailleurs (un abonnement). Avant la suppression, et sans
 * avaler l'erreur : un module qui échoue, ou qu'une maintenance tient à
 * l'arrêt, laisserait un abonnement tourner sur un compte disparu. Rend les
 * notes des modules pour le mail de confirmation.
 */
export async function notifyModulesAccountDeleted(userId: number): Promise<string[]> {
    const notes: string[] = [];
    for (const s of SERVICES) {
        if (!s.service.onAccountDeleted) continue;
        if (s.halted) {
            throw new FeatureError(
                'conflict',
                `Le module « ${s.manifest.label} » est en maintenance : réessayez plus tard.`
            );
        }
        const note = await s.service.onAccountDeleted(userId);
        if (note) notes.push(note.paragraph);
    }
    return notes;
}

/** Les échantillons de mails des modules installés, pour le testeur de la page Tests et débogage. */
export function moduleMailSamples(): { featureId: string; label: string; samples: readonly SdkMailSample[] }[] {
    return MODULES.filter((mod) => mod.server.mailSamples?.length).map((mod) => ({
        featureId: mod.manifest.id,
        label: mod.manifest.label,
        samples: mod.server.mailSamples!
    }));
}

/**
 * Les scénarios d'essai des modules installés, avec le repo que leurs étapes
 * reçoivent. Un module arrêté par la maintenance est écarté par l'appelant.
 */
export function moduleE2eEntries(db: Database): {
    featureId: string;
    label: string;
    entry: FeatureE2eEntry<unknown>;
    repo: unknown;
}[] {
    return MODULES.filter((mod) => mod.server.e2e).map((mod) => ({
        featureId: mod.manifest.id,
        label: mod.manifest.label,
        entry: mod.server.e2e!,
        repo: mod.repoFor(db)
    }));
}

/** Les fonctionnalités installées qui gèrent des domaines. */
export function moduleDomainFeatures(): string[] {
    return MODULES.filter((mod) => mod.manifest.domains && mod.server.domains).map((mod) => mod.manifest.id);
}

/** Celles dont les domaines servent des pages (`manifest.domains.web`) : le proxy et la limite d'offre ne voient qu'elles. */
export function moduleWebDomainFeatures(): string[] {
    return MODULES.filter((mod) => mod.manifest.domains?.web && mod.server.domains).map((mod) => mod.manifest.id);
}

/** Un module dont les éléments se copient ailleurs : l'entrée `copy` de ses `items`. */
export function isModuleCopyable(featureId: string): boolean {
    return BY_ID.get(featureId)?.server.items?.copy !== undefined;
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
const SERVICES: {
    manifest: FeatureManifest;
    service: FeatureService;
    logger: ModuleServiceHost['logger'];
    /** Tenu à l'arrêt par une maintenance `full` : ses hooks agent sont ignorés. */
    halted: boolean;
    /** Ses domaines, pour la racine d'un domaine client ; `null` sans `manifest.domains`. */
    domains: SdkFleetDomains | null;
}[] = [];

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
        const service = m.server.createService(
            createServiceDeps(host, m.manifest, m.repoFor(host.db), PROVIDERS, m.server.quotas)
        );
        for (const key of Object.keys(service.providers ?? {})) {
            const other = providers.get(key);
            if (other) throw new Error(`Provider « ${key} » offert par « ${other} » et « ${m.manifest.id} »`);
            providers.set(key, m.manifest.id);
        }
        SERVICES.push({
            manifest: m.manifest,
            service,
            logger: host.logger,
            halted: false,
            domains: m.manifest.domains ? sdkFleetDomains(host.db, m.manifest) : null
        });
        return [service];
    });
}

/** Le démarrage : un service qu'un arrêt complet tient à l'arrêt ne démarre pas. */
export async function startModuleServices(halted: (featureId: string) => boolean): Promise<void> {
    for (const s of SERVICES) {
        if (halted(s.manifest.id)) {
            s.halted = true;
            s.logger.warn({ module: s.manifest.id }, 'service tenu à l’arrêt par la maintenance');
            continue;
        }
        await s.service.start();
    }
}

/** L'arrêt du processus : un service déjà arrêté par la maintenance ne l'est pas deux fois. */
export function stopModuleServices(): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled(SERVICES.filter((s) => !s.halted).map(async (s) => s.service.stop()));
}

/** Ce que la maintenance pilote : l'arrêt et la relance d'un service, sur le même objet. */
export const moduleServiceControl: MaintenanceServices = {
    installed: () => MODULES.map((m) => m.manifest.id),
    hasService: (featureId) => SERVICES.some((s) => s.manifest.id === featureId),
    async stop(featureId) {
        const s = SERVICES.find((x) => x.manifest.id === featureId);
        if (!s || s.halted) return;
        // Avant l'attente : les hooks agent cessent tout de suite.
        s.halted = true;
        await s.service.stop();
    },
    async start(featureId) {
        const s = SERVICES.find((x) => x.manifest.id === featureId);
        if (!s || !s.halted) return;
        await s.service.start();
        s.halted = false;
    }
};

/** Le temps laissé à `health()` : au-delà, le module est dit dégradé. */
export const SERVICE_HEALTH_MS = 2_000;

/**
 * Le verdict d'un service sur lui-même (`FeatureService.health`), `null` quand
 * il n'en donne pas ou qu'une maintenance le tient à l'arrêt. Ne lève jamais.
 */
export async function moduleServiceHealth(featureId: string): Promise<SdkServiceHealth | null> {
    const s = SERVICES.find((x) => x.manifest.id === featureId);
    if (!s || s.halted || !s.service.health) return null;
    const late: SdkServiceHealth = { state: 'degraded', reason: 'Répond lentement' };
    try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<SdkServiceHealth>((resolve) => {
            timer = setTimeout(() => resolve(late), SERVICE_HEALTH_MS);
            timer.unref();
        });
        return await Promise.race([Promise.resolve(s.service.health()), deadline]).finally(() => clearTimeout(timer));
    } catch (e) {
        s.logger.error({ module: featureId, err: e }, 'Module health check failed');
        return { state: 'degraded' };
    }
}

/**
 * L'agrégat des hooks agent des modules qui déclarent la capacité 'agents'.
 * Chaque hook est isolé : un module qui trébuche sur une trame ne prive ni
 * les autres ni la couche socket.
 */
export function moduleAgentHooks(): Required<FeatureAgentHooks> {
    const each = (hook: keyof FeatureAgentHooks, run: (hooks: FeatureAgentHooks) => void | Promise<void>): void => {
        for (const s of SERVICES) {
            if (s.halted || !(s.manifest.nativeCapabilities ?? []).includes('agents')) continue;
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
        onSyncBusy: (deviceId, payload) => each('onSyncBusy', (h) => h.onSyncBusy?.(deviceId, payload)),
        onSyncOpResult: (deviceId, payload) => each('onSyncOpResult', (h) => h.onSyncOpResult?.(deviceId, payload)),
        onSyncDeviceKey: (deviceId, payload) => each('onSyncDeviceKey', (h) => h.onSyncDeviceKey?.(deviceId, payload))
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
export async function modulePublicRoutes(app: FastifyInstance, listener: 'app' | 'public'): Promise<void> {
    for (const s of SERVICES) {
        const exposed = (s.manifest.nativeCapabilities ?? []).includes('routes.public');
        if (s.service.domainRoot && !(exposed && s.manifest.domains?.web)) {
            throw new Error(
                `Module « ${s.manifest.id} » : domainRoot exige la capacité 'routes.public' et domains.web`
            );
        }
        const routes = s.service.publicRoutes;
        if (!routes) continue;
        if (!exposed) {
            throw new Error(`Module « ${s.manifest.id} » : publicRoutes sans la capacité 'routes.public'`);
        }
        const mount = (
            method: 'get' | 'post',
            path: string,
            opts: SdkPublicRouteOptions,
            handler: SdkPublicHandler
        ) => {
            if (path === '/') {
                throw new Error(`Module « ${s.manifest.id} » : la racine appartient à l'hôte, voir domainRoot`);
            }
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
            const appOnly = (opts.exposure ?? 'everywhere') === 'app';
            const route: RouteShorthandOptions = { logLevel: 'silent' };
            // Le plafond de corps se pose par route : le défaut de Fastify vaut un
            // mégaoctet, analysé avant toute validation, là où une balise en envoie
            // quelques kilo-octets.
            if (opts.bodyLimit !== undefined) route.bodyLimit = opts.bodyLimit;
            route.config = {
                ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
                ...(opts.rawBody ? { rawBody: true } : {})
            };
            // Deux branches plutôt qu'un `app[method]` : l'union des deux
            // signatures ne se résout pas (la surcharge WebSocket de `get`
            // prend le dessus).
            const guarded = (req: FastifyRequest, reply: FastifyReply) =>
                maintenance.refusesPublic(s.manifest.id, appOnly) ? replyMaintenance(req, reply) : handler(req, reply);
            if (method === 'get') app.get(path, route, guarded);
            else app.post(path, route, guarded);
        };
        const streams: { path: string; opts: SdkPublicStreamRouteOptions; handler: SdkPublicStreamHandler }[] = [];
        const surface: SdkPublicApp = {
            get: (path, opts, handler) => mount('get', path, opts, handler),
            post: (path, opts, handler) => mount('post', path, opts, handler),
            postStream: (path, opts, handler) => {
                if (/[:*]/.test(path)) {
                    throw new Error(`Module « ${s.manifest.id} » : postStream n'accepte pas de chemin paramétré`);
                }
                streams.push({ path, opts, handler });
            }
        };
        routes.call(s.service, surface);

        // Hors de PUBLIC_PATHS à dessein : le délégateur CORS ne les élargit
        // pas, et un envoi venu d'un autre site est arrêté au prévol par son
        // propre navigateur, avant le premier octet.
        if (streams.length === 0 || listener === 'public') continue;
        await app.register(async (scoped) => {
            // Les parseurs de contenu sont encapsulés : dans ce contexte seul,
            // rien n'est décodé et le corps reste le flux de la requête.
            scoped.removeAllContentTypeParsers();
            scoped.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
            for (const stream of streams) {
                const route: RouteShorthandOptions = { logLevel: 'silent' };
                if (stream.opts.rateLimit) route.config = { rateLimit: stream.opts.rateLimit };
                // Montées sur l'origine de l'app seule : même règle que `exposure: 'app'`.
                scoped.post(stream.path, route, (req, reply) =>
                    maintenance.refusesPublic(s.manifest.id, true)
                        ? replyMaintenance(req, reply)
                        : stream.handler(streamRequest(req, stream.opts.maxBytes), reply)
                );
            }
        });
    }

    // La racine appartient à l'hôte : servie par le module qui a vérifié ce
    // domaine client, sinon le repli de l'écouteur (le client sur l'app, 404
    // sur la surface publique).
    app.get('/', { logLevel: 'silent', config: { rateLimit: DOMAIN_ROOT_RATE_LIMIT } }, async (req, reply) => {
        if (await serveDomainRoot(req, reply)) return reply;
        reply.callNotFound();
        return reply;
    });

    // L'icône des pages publiques qui n'en ont pas à elles : sur les deux
    // écouteurs, donc sous tout domaine client, et même en maintenance.
    app.get(
        DEVEYE_ICON_PATH,
        { logLevel: 'silent', config: { rateLimit: DOMAIN_ROOT_RATE_LIMIT } },
        async (req, reply) => {
            reply
                .header('etag', DEVEYE_ICON.etag)
                .header('cache-control', 'public, max-age=86400')
                .header('cross-origin-resource-policy', 'cross-origin');
            if (req.headers['if-none-match'] === DEVEYE_ICON.etag) return reply.code(304).send();
            return reply.header('content-type', 'image/png').send(DEVEYE_ICON.bytes);
        }
    );
}

/** Le logo de DevEye en 64 pixels, lu une fois : `DEVEYE_ICON_PATH` le sert. */
const DEVEYE_ICON = (() => {
    const bytes = readFileSync(new URL('../../assets/deveye-icon.png', import.meta.url));
    return { bytes, etag: `"${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}"` };
})();

/** Une page de statut se rafraîchit en bloc pendant une panne, souvent depuis un même bureau. */
const DOMAIN_ROOT_RATE_LIMIT = { max: 300, timeWindow: '1 minute' };

/**
 * La racine d'un domaine client : le premier module installé qui a VÉRIFIÉ ce
 * nom et qui sert `domainRoot`. Vérifié et pas seulement pointé : le proxy
 * reçoit aussi les noms qui pointent ici avant leur preuve. Les hôtes de
 * DevEye ne sont jamais des domaines clients.
 */
async function serveDomainRoot(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const host = normaliseDomainHost(req.host ?? '');
    if (!DOMAIN_HOST_PATTERN.test(host)) return false;
    if (host === new URL(ORIGINS.app).hostname || host === new URL(ORIGINS.public).hostname) return false;
    for (const s of SERVICES) {
        const root = s.service.domainRoot;
        if (!root || !s.domains) continue;
        const domain = await s.domains.findByHost(host);
        if (!domain?.verified) continue;
        if (maintenance.refusesPublic(s.manifest.id, false)) {
            await replyMaintenance(req, reply);
            return true;
        }
        await root.call(s.service, req, reply, domain);
        return true;
    }
    return false;
}

/**
 * La requête d'une route en flux telle qu'un module la voit. Le plafond est
 * tenu ici et non par `bodyLimit`, qui ne s'applique pas à un parseur qui ne
 * tamponne pas.
 */
export function streamRequest(req: FastifyRequest, maxBytes: number): SdkPublicStreamRequest {
    const raw = req.body as Readable;
    const declared = Number(req.headers['content-length']);
    return {
        headers: req.headers,
        query: req.query,
        params: req.params,
        host: req.host,
        ip: req.ip,
        body: {
            contentLength: Number.isFinite(declared) ? declared : null,
            bytes: async function* () {
                let seen = 0;
                for await (const chunk of raw as AsyncIterable<Buffer>) {
                    seen += chunk.length;
                    if (seen > maxBytes) {
                        // Détruire et non cesser de lire : sinon le client
                        // continue d'émettre dans un tampon qui ne se vide plus.
                        raw.destroy();
                        throw new FeatureError('validation', `Corps trop volumineux (plafond de ${maxBytes} octets)`);
                    }
                    yield chunk;
                }
            }
        }
    };
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
 * Ce qu'un `<form method="post">` sans JavaScript envoie, décodé pour les deux
 * écouteurs. Un nom répété devient un tableau, sans quoi un groupe de cases à
 * cocher perdrait toutes ses valeurs sauf une.
 *
 * Le plafond de paires n'est pas décoratif : sans lui, un corps d'un mégaoctet
 * de `a0=&a1=&…` fait deux cent mille entrées, chacune validée ensuite contre
 * le schéma du module avant qu'aucune borne de cardinalité ne morde. Un
 * formulaire réel en porte quelques dizaines ; au-delà, le corps n'en est pas
 * un et vaut `undefined`, que la validation écarte comme le reste.
 *
 * Sans prototype : un champ nommé `__proto__` poserait sinon un accesseur au
 * lieu d'une réponse.
 */
const FORM_FIELDS_MAX = 64;

export function parseFormFields(body: string): Record<string, string | string[]> | undefined {
    const fields: Record<string, string | string[]> = Object.create(null);
    let count = 0;
    for (const [name, value] of new URLSearchParams(body)) {
        const seen = fields[name];
        if (seen === undefined) {
            if (++count > FORM_FIELDS_MAX) return undefined;
            fields[name] = value;
        } else if (Array.isArray(seen)) seen.push(value);
        else fields[name] = [seen, value];
    }
    return fields;
}

/**
 * Les sujets live que les modules installés peuvent battre : leur id et leurs
 * sujets secondaires (`manifest.topics`). Lu à l'appel par `_topics.ts`, jamais
 * au chargement, pour que l'ordre des imports ne compte pas.
 */
export function moduleTopics(): readonly string[] {
    return MODULES.flatMap((m) => [m.manifest.id, ...(m.manifest.topics ?? []).map((t) => t.id)]);
}
