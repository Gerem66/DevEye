import { isExternalFeatureId, registerExternalFeature, type ExternalFeatureId } from 'deveye-types';
import { validateManifest, type FeatureManifest } from 'deveye-types/sdk';
import type { FeatureServer, FeatureService, SdkQueryable } from 'deveye-types/sdk/server';
import { FeatureError } from 'deveye-types/sdk/server';

import type { Database } from '@/db';
import type { Queryable } from '@/db/pool';
import { defineFeature, type FeatureDefinition } from '@/features/_define';
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
        if (!isExternalFeatureId(manifest.id)) {
            throw new Error(`Module « ${manifest.id} » : une feature native ne s'installe pas par la config`);
        }
        if (BY_ID.has(manifest.id)) {
            throw new Error(`Module « ${manifest.id} » : déclaré deux fois dans features.config.json`);
        }
        if ((manifest.nativeCapabilities ?? []).includes('notify') && !manifest.notifies) {
            throw new Error(`Module « ${manifest.id} » : la capacité 'notify' exige notifies: true`);
        }
        registerExternalFeature({
            id: manifest.id as ExternalFeatureId,
            label: manifest.label,
            description: manifest.description,
            icon: manifest.icon,
            notifies: manifest.notifies,
            hasItems: manifest.hasItems,
            itemNoun: manifest.itemNoun,
            sources: manifest.sources,
            shareTier: manifest.shareTier
        });
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
                mutates: def.mutates ? true : undefined,
                handler: async (ctx, input) => {
                    const sdkCtx = createSdkContext(ctx, mod.manifest, mod.repoFor(ctx.db));
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

/** Les services d'arrière-plan des modules, à démarrer avec les natifs. */
export function createModuleServices(host: ModuleServiceHost): FeatureService[] {
    return MODULES.flatMap((m) => {
        if (!m.server.createService) return [];
        return [m.server.createService(createServiceDeps(host, m.manifest, m.repoFor(host.db)))];
    });
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
