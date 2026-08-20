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
} from 'deveye-types';
import type { GitRepoUsage } from 'deveye-types';
import { listOwnerRepos } from '@/Services/integrations/github';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { tryDecryptProject } from '../project/_shared';
import { shareScope } from '../_sharing';
import {
    gitCipher,
    loadHomeRepo,
    loadRepo,
    READ,
    reloadRepo,
    repoCipher,
    slugRef,
    toRepo,
    WRITE,
    type StoredRepo
} from './_shared';

/**
 * Les dépôts de l'espace : ajout, réglages, suppression, synchronisation.
 *
 * Rien ici n'appelle GitHub directement — même `repoSyncNow` ne fait que
 * réveiller le service de fond. C'est ce qui garde une commande WS courte et
 * prévisible : aucune ne dépend de la latence d'une API tierce.
 */

export const gitCountFeature: FeatureDefinition<
    typeof gitCount.command,
    typeof gitCount.input,
    typeof gitCount.output
> = defineFeature({
    ...gitCount,
    access: READ,
    handler: async (ctx) => ({ count: await ctx.db.git.countRepos(ctx.workspaceId) })
});

export const gitRepoListFeature: FeatureDefinition<
    typeof gitRepoList.command,
    typeof gitRepoList.input,
    typeof gitRepoList.output
> = defineFeature({
    ...gitRepoList,
    access: READ,
    handler: async (ctx) => {
        const rows = await ctx.db.git.listVisibleRepos(ctx.workspaceId);
        // Les dépôts qu'une restriction masque pour ce rôle disparaissent de la
        // liste plutôt que d'y figurer grisés.
        const hidden = await ctx.itemRestrictions('git');
        const visible = rows.filter((r) => hidden.get(r.id) !== 'none');
        const shares = await shareScope(ctx, 'git');
        return {
            repos: await Promise.all(
                visible.map(async (row) =>
                    toRepo(await shares.cipherFor(row.id), row, row.workspace_id !== ctx.workspaceId)
                )
            )
        };
    }
});

export const gitRepoGetFeature: FeatureDefinition<
    typeof gitRepoGet.command,
    typeof gitRepoGet.input,
    typeof gitRepoGet.output
> = defineFeature({
    ...gitRepoGet,
    access: READ,
    handler: async (ctx, input) => {
        const row = await ctx.db.git.findVisibleRepoWithUsage(input.repoId, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Dépôt introuvable');
        await ctx.assertItem('git', input.repoId);
        // Deux codecs, et ce n'est pas une redondance : le dépôt est chiffré
        // chez LUI, les projets liés listés ici sont ceux d'ICI.
        const cipher = gitCipher(ctx);

        // Les projets liés, avec leur titre : c'est ce qui rend l'interconnexion
        // cliquable dans les deux sens. Ils sont tous à l'étage ouvert (la
        // requête le garantit), donc lisibles sans session — un projet
        // confidentiel ne peut pas être lié.
        const usage: GitRepoUsage[] = await Promise.all(
            (await ctx.db.git.listUsage(input.repoId, ctx.workspaceId)).map(async (u) => ({
                projectId: u.project_id,
                title: (await tryDecryptProject(cipher, u.content))?.title || 'Sans titre',
                status: u.status as GitRepoUsage['status']
            }))
        );

        return { repo: await toRepo(await repoCipher(ctx, row.id), row, row.workspace_id !== ctx.workspaceId), usage };
    }
});

export const gitRepoAddFeature: FeatureDefinition<
    typeof gitRepoAdd.command,
    typeof gitRepoAdd.input,
    typeof gitRepoAdd.output
> = defineFeature({
    ...gitRepoAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        if (input.credentialId !== null) {
            const credential = await ctx.db.credentials.find(input.credentialId, ctx.workspaceId, 'github');
            if (!credential) throw new FeatureError('not_found', 'Jeton introuvable');
            if (credential.provider !== input.provider) {
                throw new FeatureError('validation', 'Ce jeton ne correspond pas au fournisseur choisi.');
            }
        }

        const owner = input.owner.trim();
        const repo = input.repo.trim();
        const ref = slugRef(owner, repo);

        // **Idempotence.** Le même dépôt déjà présent rend sa ligne, avec le
        // jeton mis à jour — jamais un doublon. C'est ce qui permet à un projet
        // de « créer » un dépôt sans savoir s'il existe déjà ailleurs dans
        // l'espace, et ce qui garantit qu'un dépôt n'est jamais synchronisé deux
        // fois sous deux quotas.
        const existing = await ctx.db.git.findRepoBySlug(ctx.workspaceId, ref);
        if (existing) {
            await ctx.db.git.updateRepo(existing.id, ctx.workspaceId, {
                credentialId: input.credentialId,
                enabled: existing.enabled === 1
            });
            ctx.integrations?.requestSync(existing.id);
            return { repo: await reloadRepo(ctx, existing.id) };
        }

        const payload: StoredRepo = { owner, repo };
        const row = await ctx.db.git.createRepo({
            workspaceId: ctx.workspaceId,
            provider: input.provider,
            slugRef: ref,
            credentialId: input.credentialId,
            content: await gitCipher(ctx).encrypt(JSON.stringify(payload))
        });
        ctx.audit({
            action: 'git.repoAdd',
            description: 'Dépôt ajouté à l’espace',
            metadata: { repoId: row.id, provider: input.provider }
        });
        // Première lecture tout de suite : attendre deux minutes pour voir
        // apparaître quoi que ce soit donnerait l'impression que ça n'a pas
        // fonctionné.
        ctx.integrations?.requestSync(row.id);
        return { repo: await reloadRepo(ctx, row.id) };
    }
});

/**
 * Les dépôts d'un propriétaire, chez le fournisseur.
 *
 * Pas de `mutates` — elle n'écrit rien — mais sous le droit d'**écriture** : elle
 * consomme le quota d'un jeton de l'espace et sonde des organisations, ce qui
 * n'a de sens que pour qui s'apprête à ajouter un dépôt.
 *
 * Les dépôts déjà connus de l'espace sont marqués `known` plutôt qu'écartés :
 * `git.repoAdd` étant idempotente, les rechoisir est sans danger, et les faire
 * disparaître de la liste ferait croire qu'ils n'existent pas chez GitHub.
 */
export const gitRepoCandidatesFeature: FeatureDefinition<
    typeof gitRepoCandidates.command,
    typeof gitRepoCandidates.input,
    typeof gitRepoCandidates.output
> = defineFeature({
    ...gitRepoCandidates,
    access: WRITE,
    handler: async (ctx, input) => {
        const owner = input.owner.trim();

        // Sans jeton, la découverte reste possible : GitHub rend le public à
        // qui le demande. C'est ce qui permet de chercher un dépôt **avant**
        // d'avoir enregistré le moindre jeton — le moment précis où l'on en a
        // besoin.
        let token: string | null = null;
        if (input.credentialId !== null) {
            const credential = await ctx.db.credentials.find(input.credentialId, ctx.workspaceId, 'github');
            if (!credential) throw new FeatureError('not_found', 'Jeton introuvable');
            if (credential.provider !== 'github') {
                throw new FeatureError('validation', 'Ce jeton n’est pas un jeton GitHub.');
            }
            token = await gitCipher(ctx).decrypt(credential.secret_enc);
        }

        const [remote, known] = await Promise.all([
            listOwnerRepos(owner, token),
            ctx.db.git.listRepos(ctx.workspaceId)
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
                // Par ordre alphabétique, et non par date de dernier push.
                //
                // Les deux tris ne répondent pas à la même question, et il faut
                // les deux : `sort=pushed` côté fournisseur décide **quels**
                // dépôts on reçoit quand il y en a plus de cent — les plus
                // vivants d'abord. Celui-ci décide **comment on les lit** dans
                // un sélecteur, où l'on cherche un nom qu'on connaît déjà.
                //
                // `localeCompare` et non `<` : les accents et la casse ne
                // doivent pas éparpiller la liste, et `numeric` range `api-2`
                // avant `api-10` au lieu de l'inverse.
                .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base', numeric: true }))
        };
    }
});

export const gitRepoUpdateFeature: FeatureDefinition<
    typeof gitRepoUpdate.command,
    typeof gitRepoUpdate.input,
    typeof gitRepoUpdate.output
> = defineFeature({
    ...gitRepoUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        // Domicile seulement : le jeton d'un dépôt se choisit parmi les clés de
        // SON espace, que la fenêtre ne voit pas.
        const existing = await loadHomeRepo(ctx, input.repoId);
        if (input.credentialId !== null) {
            const credential = await ctx.db.credentials.find(input.credentialId, ctx.workspaceId, 'github');
            if (!credential) throw new FeatureError('not_found', 'Jeton introuvable');
            if (credential.provider !== existing.provider) {
                throw new FeatureError('validation', 'Ce jeton ne correspond pas au fournisseur du dépôt.');
            }
        }
        const row = await ctx.db.git.updateRepo(input.repoId, ctx.workspaceId, {
            credentialId: input.credentialId,
            enabled: input.enabled
        });
        if (!row) throw new FeatureError('not_found', 'Dépôt introuvable');
        // Un jeton qui vient d'arriver rend le dépôt lisible : autant s'y mettre.
        if (input.enabled && input.credentialId !== null && existing.credential_id === null) {
            ctx.integrations?.requestSync(input.repoId);
        }
        return { repo: await reloadRepo(ctx, input.repoId) };
    }
});

export const gitRepoRemoveFeature: FeatureDefinition<
    typeof gitRepoRemove.command,
    typeof gitRepoRemove.input,
    typeof gitRepoRemove.output
> = defineFeature({
    ...gitRepoRemove,
    // Deux sujets : les projets liés perdent leur dépôt, leur onglet Git doit
    // donc se rafraîchir lui aussi.
    mutates: ['git', 'projects'],
    access: WRITE,
    handler: async (ctx, input) => {
        // Le cache et les liaisons partent en CASCADE. Les projets, eux, ne
        // perdent qu'un pointeur — c'est tout l'intérêt d'avoir séparé les deux.
        const ok = await ctx.db.git.deleteRepo(input.repoId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Dépôt introuvable');
        // Projections et restrictions ne tiennent à aucune clé étrangère : sans
        // ce ménage, elles s'appliqueraient au prochain dépôt à hériter de
        // l'identifiant.
        await ctx.db.itemSharing.forgetItem('git', input.repoId, ctx.workspaceId);
        ctx.audit({
            action: 'git.repoRemove',
            description: 'Dépôt retiré de l’espace',
            metadata: { repoId: input.repoId }
        });
        return { repoId: input.repoId };
    }
});

/**
 * Range les dépôts de l'espace.
 *
 * `mutates` sans audit : c'est une disposition, pas une configuration — elle ne
 * change ni accès, ni cache, ni synchronisation. Les autres membres doivent en
 * revanche la voir, l'ordre étant une propriété de l'espace et non du navigateur
 * qui l'a posé.
 *
 * ⚠️ Le filet de démarrage ne voit pas cette commande : `MUTATION_VERB` cherche
 * un verbe juste après le point, et « repoReorder » n'en est pas un. Le
 * `mutates` ci-dessous se relit à la main, comme tout le module.
 */
export const gitRepoReorderFeature: FeatureDefinition<
    typeof gitRepoReorder.command,
    typeof gitRepoReorder.input,
    typeof gitRepoReorder.output
> = defineFeature({
    ...gitRepoReorder,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await ctx.db.git.reorderRepos(ctx.workspaceId, input.ids);
        return { ids: input.ids };
    }
});

export const gitRepoSyncNowFeature: FeatureDefinition<
    typeof gitRepoSyncNow.command,
    typeof gitRepoSyncNow.input,
    typeof gitRepoSyncNow.output
> = defineFeature({
    ...gitRepoSyncNow,
    // Pas de `mutates` : cette commande n'écrit rien elle-même, elle réveille
    // l'ordonnanceur. C'est lui qui diffusera quand il aura écrit.
    access: WRITE,
    handler: async (ctx, input) => {
        // Depuis la fenêtre aussi : réveiller la synchronisation d'un dépôt
        // projeté rafraîchit la même donnée pour tout le monde, chez lui.
        await loadRepo(ctx, input.repoId, 'write');
        if (!ctx.integrations) throw new FeatureError('internal', 'Service de synchronisation indisponible');
        ctx.integrations.requestSync(input.repoId);
        return { repo: await reloadRepo(ctx, input.repoId) };
    }
});

/**
 * Repart de zéro : le cache est jeté, tout sera relu.
 *
 * `mutates` — contrairement à `repoSyncNow`, qui ne fait que réveiller
 * l'ordonnanceur, celle-ci **écrit** : elle supprime des lignes, et l'écran des
 * autres membres doit s'en apercevoir.
 */
export const gitRepoResyncFeature: FeatureDefinition<
    typeof gitRepoResync.command,
    typeof gitRepoResync.input,
    typeof gitRepoResync.output
> = defineFeature({
    ...gitRepoResync,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const ok = await ctx.db.git.resetCache(input.repoId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Dépôt introuvable');
        ctx.audit({
            action: 'git.repoResync',
            description: 'Cache du dépôt vidé, relecture complète demandée',
            metadata: { repoId: input.repoId }
        });
        // Tout de suite : c'est un geste explicite, attendre le tour de
        // l'ordonnanceur donnerait l'impression qu'il ne s'est rien passé.
        ctx.integrations?.requestSync(input.repoId);
        return { repo: await reloadRepo(ctx, input.repoId) };
    }
});

/**
 * Où en est la synchronisation de ce dépôt.
 *
 * Pas de `mutates` — elle n'écrit rien — et volontairement **très bon marché** :
 * elle ne lit qu'une table en mémoire du service. C'est ce qui permet à
 * l'interface de la sonder pendant qu'une synchronisation tourne, plutôt que de
 * diffuser une invalidation `live` à chaque étape, laquelle ferait re-solliciter
 * tout l'écran six fois d'affilée chez tous les membres de l'espace.
 */
export const gitRepoSyncStatusFeature: FeatureDefinition<
    typeof gitRepoSyncStatus.command,
    typeof gitRepoSyncStatus.input,
    typeof gitRepoSyncStatus.output
> = defineFeature({
    ...gitRepoSyncStatus,
    access: READ,
    handler: async (ctx, input) => {
        // `loadRepo` porte la frontière d'espace : sans lui, on répondrait sur
        // l'identifiant d'un dépôt d'un autre espace.
        await loadRepo(ctx, input.repoId);
        const status = ctx.integrations?.syncStatus(input.repoId) ?? {
            running: false,
            phase: null,
            step: 0,
            stepCount: 1,
            startedAt: null
        };
        return { status };
    }
});

/**
 * Toutes les synchronisations en cours de l'espace, d'un coup.
 *
 * Ni `mutates` ni requête : elle ne lit qu'une table en mémoire du service. À ce
 * prix-là, la liste des dépôts peut la sonder à la seconde pour animer une bande
 * de progression par carte — c'est le même arbitrage que la barre d'une synchro
 * mail, et la même raison (voir LIVE.md).
 */
export const gitSyncStatusesFeature: FeatureDefinition<
    typeof gitSyncStatuses.command,
    typeof gitSyncStatuses.input,
    typeof gitSyncStatuses.output
> = defineFeature({
    ...gitSyncStatuses,
    access: READ,
    handler: async (ctx) => ({ statuses: ctx.integrations?.runningIn(ctx.workspaceId) ?? [] })
});

export const gitRepoFeatures = [
    gitCountFeature,
    gitRepoListFeature,
    gitRepoGetFeature,
    gitRepoAddFeature,
    gitRepoCandidatesFeature,
    gitRepoUpdateFeature,
    gitRepoRemoveFeature,
    gitRepoReorderFeature,
    gitRepoSyncNowFeature,
    gitRepoResyncFeature,
    gitRepoSyncStatusFeature,
    gitSyncStatusesFeature
];
