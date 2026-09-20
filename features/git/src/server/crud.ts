import {
    gitCount,
    gitRepoAdd,
    gitRepoCandidates,
    gitRepoGet,
    gitRepoList,
    gitRepoRemove,
    gitRepoReorder,
    gitRepoResync,
    gitRepoSyncNow,
    gitRepoSyncStatus,
    gitRepoUpdate,
    gitSyncStatuses
} from '../contracts/commands';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { listOwnerRepos } from './github';
import {
    loadHomeRepo,
    loadRepo,
    projectCountsOf,
    projectUsageOf,
    reloadRepo,
    repoCipher,
    requestSync,
    slugRef,
    syncOf,
    toRepo,
    type Ctx,
    type StoredRepo
} from './_shared';

/**
 * Les dépôts de l'espace : ajout, réglages, suppression, synchronisation.
 *
 * Rien ici n'appelle GitHub directement, même `repoSyncNow` ne fait que réveiller
 * le service de fond : aucune commande ne dépend de la latence d'une API tierce.
 * Seule exception, `repoCandidates`, une liste qu'on regarde au moment d'ajouter.
 *
 * Le filet de démarrage ne reconnaît aucune de ces commandes : il cherche un verbe
 * juste après le point, et les noms sont en camelCase. `mutates` se relit donc à
 * la main sur chaque écriture.
 */

/** L'état « rien en cours », ce que rend `syncStatus` hors service. */
const IDLE = { running: false, phase: null, step: 0, stepCount: 1, startedAt: null };

export const gitCrudFeatures = [
    defineSdkFeature({
        ...gitCount,
        handler: async (ctx: Ctx) => {
            // Les mêmes lignes que la liste — projetées comprises, restrictions
            // déduites : la carte doit compter ce que la liste montre.
            const rows = await ctx.repo.listVisibleRepos(ctx.workspaceId);
            const hidden = await ctx.items.restrictions();
            return { count: rows.filter((r) => hidden.get(String(r.id)) !== 'none').length };
        }
    }),
    defineSdkFeature({
        ...gitRepoList,
        handler: async (ctx: Ctx) => {
            const rows = await ctx.repo.listVisibleRepos(ctx.workspaceId);
            // Les dépôts qu'une restriction masque pour ce rôle disparaissent de la
            // liste plutôt que d'y figurer grisés.
            const hidden = await ctx.items.restrictions();
            const visible = rows.filter((r) => hidden.get(String(r.id)) !== 'none');
            const [shares, counts] = await Promise.all([ctx.sharing.scope(), projectCountsOf(ctx)]);
            return {
                repos: await Promise.all(
                    visible.map(async (row) =>
                        toRepo(
                            await shares.cipherFor(String(row.id)),
                            row,
                            row.workspace_id !== ctx.workspaceId,
                            counts.get(row.id) ?? 0
                        )
                    )
                )
            };
        }
    }),
    defineSdkFeature({
        ...gitRepoGet,
        handler: async (ctx: Ctx, input) => {
            const row = await loadRepo(ctx, input.repoId);
            // Deux sources, et ce n'est pas une redondance : le dépôt est chiffré
            // chez LUI, les projets liés listés ici sont ceux d'ICI, par le
            // contrat de Projets (le module ne lit aucune de ses tables).
            const [usage, counts] = await Promise.all([projectUsageOf(ctx, input.repoId), projectCountsOf(ctx)]);
            return {
                repo: await toRepo(
                    await repoCipher(ctx, row.id),
                    row,
                    row.workspace_id !== ctx.workspaceId,
                    counts.get(row.id) ?? 0
                ),
                usage: usage.map((u) => ({ projectId: u.projectId, title: u.title, status: u.status }))
            };
        }
    }),
    defineSdkFeature({
        ...gitRepoAdd,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Le jeton existe-t-il, et dans cet espace ? Sans cette garde on
            // relierait un dépôt au jeton d'un autre espace, dont l'existence même
            // n'a pas à fuiter.
            if (input.credentialId !== null) {
                const credential = await ctx.repo.findCredential(input.credentialId, ctx.workspaceId);
                if (!credential) throw new FeatureError('not_found', 'Jeton introuvable');
            }

            const owner = input.owner.trim();
            const repo = input.repo.trim();
            const ref = slugRef(owner, repo);

            // Idempotence : le même dépôt déjà présent rend sa ligne avec le jeton
            // mis à jour, jamais un doublon. Un projet peut donc « créer » un dépôt
            // sans savoir s'il existe ailleurs dans l'espace, et aucun dépôt n'est
            // synchronisé deux fois sous deux quotas.
            const existing = await ctx.repo.findRepoBySlug(ctx.workspaceId, ref);
            if (existing) {
                await ctx.repo.updateRepo(existing.id, ctx.workspaceId, {
                    credentialId: input.credentialId,
                    enabled: existing.enabled === 1
                });
                requestSync(existing.id);
                return { repo: await reloadRepo(ctx, existing.id) };
            }

            // Après l'idempotence : remettre à jour un dépôt déjà suivi n'en
            // ajoute aucun, et ne doit donc jamais buter sur la limite.
            await ctx.quota.assert('repos', async (owned) => (await ctx.repo.countReposInWorkspaces(owned)) + 1);

            const payload: StoredRepo = { owner, repo };
            const row = await ctx.repo.createRepo({
                workspaceId: ctx.workspaceId,
                provider: input.provider,
                slugRef: ref,
                credentialId: input.credentialId,
                content: await ctx.cipher().encrypt(JSON.stringify(payload))
            });
            ctx.audit({
                action: 'git.repoAdd',
                description: 'Dépôt ajouté à l’espace',
                metadata: { repoId: row.id, provider: input.provider }
            });
            // Première lecture tout de suite : attendre le tour de l'ordonnanceur
            // donnerait l'impression que l'ajout n'a pas fonctionné.
            requestSync(row.id);
            return { repo: await reloadRepo(ctx, row.id) };
        }
    }),
    /**
     * Les dépôts d'un propriétaire, chez le fournisseur. Elle n'écrit rien mais reste
     * sous le droit d'écriture : elle consomme le quota d'un jeton de l'espace et
     * sonde des organisations.
     *
     * Les dépôts déjà connus sont marqués `known` plutôt qu'écartés : `git.repoAdd`
     * étant idempotente, les rechoisir est sans danger, et les masquer ferait croire
     * qu'ils n'existent pas chez GitHub.
     */
    defineSdkFeature({
        ...gitRepoCandidates,
        access: { level: 'write' },
        handler: async (ctx: Ctx, input) => {
            const owner = input.owner.trim();

            // Sans jeton, la découverte reste possible, GitHub rendant le public à
            // qui le demande : on peut chercher un dépôt avant d'avoir enregistré
            // le moindre jeton.
            let token: string | null = null;
            if (input.credentialId !== null) {
                const credential = await ctx.repo.findCredential(input.credentialId, ctx.workspaceId);
                if (!credential) throw new FeatureError('not_found', 'Jeton introuvable');
                token = await ctx.cipher().decrypt(credential.secret_enc);
            }

            const [remote, known] = await Promise.all([
                listOwnerRepos(owner, token),
                ctx.repo.listRepos(ctx.workspaceId)
            ]);
            const knownSlugs = new Set(known.map((r) => r.slug_ref));

            return {
                repos: remote
                    .map((r) => ({
                        name: r.name,
                        private: r.private,
                        archived: r.archived,
                        description: r.description,
                        pushedAt: r.pushedAt,
                        known: knownSlugs.has(slugRef(owner, r.name))
                    }))
                    // Les deux tris se complètent : `sort=pushed` côté fournisseur
                    // décide quels dépôts on reçoit au-delà de cent, celui-ci
                    // comment on les lit dans un sélecteur, où l'on cherche un nom
                    // connu. `localeCompare` et non `<` : les accents et la casse ne
                    // doivent pas éparpiller la liste, et `numeric` range `api-2`
                    // avant `api-10`.
                    .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base', numeric: true }))
            };
        }
    }),
    defineSdkFeature({
        ...gitRepoUpdate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Domicile seulement : le jeton d'un dépôt se choisit parmi les clés de
            // SON espace, que la fenêtre ne voit pas.
            const existing = await loadHomeRepo(ctx, input.repoId);
            if (input.credentialId !== null) {
                const credential = await ctx.repo.findCredential(input.credentialId, ctx.workspaceId);
                if (!credential) throw new FeatureError('not_found', 'Jeton introuvable');
            }
            const row = await ctx.repo.updateRepo(input.repoId, ctx.workspaceId, {
                credentialId: input.credentialId,
                enabled: input.enabled
            });
            if (!row) throw new FeatureError('not_found', 'Dépôt introuvable');
            // Un jeton qui vient d'arriver rend le dépôt lisible : autant s'y mettre.
            if (input.enabled && input.credentialId !== null && existing.credential_id === null) {
                requestSync(input.repoId);
            }
            return { repo: await reloadRepo(ctx, input.repoId) };
        }
    }),
    defineSdkFeature({
        ...gitRepoRemove,
        access: { level: 'write' },
        // Un seul sujet, celui du module : les compteurs d'onglets d'un projet
        // dépendent du sujet `projects`, qu'un module ne peut pas nommer, et se
        // remettent à jour à leur prochaine lecture.
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Domicile seulement : une fenêtre ne supprime pas la donnée d'un
            // autre espace.
            await loadHomeRepo(ctx, input.repoId);
            // Le cache et les liaisons partent en CASCADE ; les projets, eux, ne
            // perdent qu'un pointeur.
            const ok = await ctx.repo.deleteRepo(input.repoId, ctx.workspaceId);
            if (!ok) throw new FeatureError('not_found', 'Dépôt introuvable');
            // Projections et restrictions ne tiennent à aucune clé étrangère : sans
            // ce ménage, elles s'appliqueraient au prochain dépôt à hériter de
            // l'identifiant.
            await ctx.items.forget(String(input.repoId));
            ctx.audit({
                action: 'git.repoRemove',
                description: 'Dépôt retiré de l’espace',
                metadata: { repoId: input.repoId }
            });
            return { repoId: input.repoId };
        }
    }),
    /**
     * Range les dépôts de l'espace. `mutates` sans audit : c'est une disposition, qui
     * ne change ni accès, ni cache, ni synchronisation, mais que les autres membres
     * doivent voir, l'ordre étant une propriété de l'espace.
     */
    defineSdkFeature({
        ...gitRepoReorder,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            await ctx.repo.reorderRepos(ctx.workspaceId, input.ids);
            return { ids: input.ids };
        }
    }),
    defineSdkFeature({
        ...gitRepoSyncNow,
        // Pas de `mutates` : cette commande n'écrit rien elle-même, elle réveille
        // l'ordonnanceur. C'est lui qui diffusera quand il aura écrit.
        access: { level: 'write' },
        handler: async (ctx: Ctx, input) => {
            // Depuis la fenêtre aussi : réveiller la synchronisation d'un dépôt
            // projeté rafraîchit la même donnée pour tout le monde, chez lui.
            await loadRepo(ctx, input.repoId, 'write');
            requestSync(input.repoId);
            return { repo: await reloadRepo(ctx, input.repoId) };
        }
    }),
    /**
     * Repart de zéro : le cache est jeté, tout sera relu. `mutates`, contrairement à
     * `repoSyncNow` : celle-ci supprime des lignes, et l'écran des autres membres
     * doit s'en apercevoir.
     */
    defineSdkFeature({
        ...gitRepoResync,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const ok = await ctx.repo.resetCache(input.repoId, ctx.workspaceId);
            if (!ok) throw new FeatureError('not_found', 'Dépôt introuvable');
            ctx.audit({
                action: 'git.repoResync',
                description: 'Cache du dépôt vidé, relecture complète demandée',
                metadata: { repoId: input.repoId }
            });
            // Tout de suite : c'est un geste explicite, attendre le tour de
            // l'ordonnanceur donnerait l'impression qu'il ne s'est rien passé.
            requestSync(input.repoId);
            return { repo: await reloadRepo(ctx, input.repoId) };
        }
    }),
    /**
     * Où en est la synchronisation de ce dépôt. Volontairement très bon marché, elle
     * ne lit qu'une table en mémoire du service : l'interface peut la sonder au lieu
     * de diffuser une invalidation `live` à chaque étape, chez tous les membres.
     */
    defineSdkFeature({
        ...gitRepoSyncStatus,
        handler: async (ctx: Ctx, input) => {
            // `loadRepo` porte la frontière d'espace : sans lui, on répondrait sur
            // l'identifiant d'un dépôt d'un autre espace.
            await loadRepo(ctx, input.repoId);
            return { status: syncOf()?.syncStatus(input.repoId) ?? IDLE };
        }
    }),
    /**
     * Toutes les synchronisations en cours de l'espace, d'un coup. Aucune requête,
     * une table en mémoire : à ce prix-là, la liste des dépôts peut la sonder à la
     * seconde pour animer une bande de progression par carte.
     */
    defineSdkFeature({
        ...gitSyncStatuses,
        handler: async (ctx: Ctx) => ({ statuses: syncOf()?.runningIn(ctx.workspaceId) ?? [] })
    })
];
