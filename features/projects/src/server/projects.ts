import {
    projectAdd,
    projectArchive,
    projectCount,
    projectGet,
    projectList,
    projectReorder,
    projectRestore,
    projectSetSecurityTier,
    projectSetStatus,
    projectSetVersion,
    projectUpdate
} from '../contracts/commands';
import type { ProjectDraft, ProjectRow, ProjectSummary } from '../contracts/domain';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    assertGuardedAllowed,
    assertProjectUnlocked,
    cipherFor,
    decryptProject,
    encryptColumn,
    encryptProject,
    loadProject,
    recordEvent,
    reencryptProjectTree,
    toMaskedSummary,
    toProject,
    toSummary,
    tryDecryptProject,
    WRITE,
    type Ctx,
    type StoredProject
} from './_shared';

/**
 * Le portefeuille : les projets de l'espace actif.
 *
 * L'espace vient de l'enveloppe WS et l'appartenance est déjà vérifiée par le
 * dispatcheur : les handlers filtrent sur `ctx.workspaceId`, sans garde ni
 * traduction d'id.
 *
 * ⚠️ Le contrôle de démarrage de `_topics.ts` qui attrape un `mutates` oublié
 * cherche un verbe **juste après le point** (`notes.add`). Les commandes d'ici
 * sont en camelCase sous un préfixe unique (`projects.setStatus`) : il n'en
 * verra aucune. `mutates` est donc à relire à la main sur toute écriture
 * ajoutée ici.
 */

/**
 * Colonnes posées d'office à la création.
 *
 * Un tableau sans colonne est une impasse : on ne peut y créer aucune carte, et
 * rien n'indique par où commencer. La dernière porte `countsAsDone`, ce qui rend
 * l'avancement du projet calculable dès la première carte.
 */
const DEFAULT_COLUMNS: { name: string; countsAsDone: boolean }[] = [
    { name: 'À faire', countsAsDone: false },
    { name: 'En cours', countsAsDone: false },
    { name: 'Terminé', countsAsDone: true }
];

/** Le corps chiffré, à partir d'un brouillon et de la version à conserver. */
function toPayload(draft: ProjectDraft, version: string): StoredProject {
    return {
        title: draft.title,
        icon: draft.icon,
        description: draft.description,
        tags: draft.tags,
        version
    };
}

/** Relit et déchiffre une ligne fraîchement écrite, pour la renvoyer entière. */
async function readProject(ctx: Ctx, row: ProjectRow) {
    const payload = await decryptProject(cipherFor(ctx, row.security_tier), row.content);
    if (!payload) throw new FeatureError('internal', 'Le corps du projet est illisible');
    return toProject(row, payload);
}

export const projectListFeature = defineSdkFeature({
    ...projectList,
    handler: async (ctx: Ctx, input) => {
        const wantArchived = input.archived === true;
        const rows = await ctx.repo.projects.listByWorkspace(ctx.workspaceId, wantArchived);

        // Compteurs d'abord : ils ne dépendent d'aucune clé, et doivent donc
        // s'afficher même sur un projet gardé qu'on ne sait pas déchiffrer.
        const stats = new Map(
            (await ctx.repo.projects.statsByWorkspace(ctx.workspaceId, ctx.userId, Math.floor(Date.now() / 1000))).map(
                (s) => [s.project_id, s]
            )
        );

        // Jamais bloquée : la liste s'affiche toujours. Un projet gardé n'est
        // révélé que si la DEK est déjà vivante, et on ne le demande (ce qui
        // fait glisser la fenêtre de grâce) que s'il y a vraiment un projet
        // gardé à révéler.
        const canReadGuarded = rows.some((r) => r.security_tier === 'guarded') ? await ctx.secrecy.isUnlocked() : false;

        let skipped = 0;
        const projects = (
            await Promise.all(
                rows.map(async (row): Promise<ProjectSummary | null> => {
                    const guarded = row.security_tier === 'guarded';
                    if (guarded && !canReadGuarded) return toMaskedSummary(row, stats.get(row.id));
                    const payload = await tryDecryptProject(cipherFor(ctx, row.security_tier), row.content);
                    if (!payload) {
                        // Ligne corrompue (ou clé qui ne correspond plus) : on la
                        // laisse de côté plutôt que de faire échouer toute la liste.
                        skipped += 1;
                        return null;
                    }
                    return toSummary(row, payload, stats.get(row.id));
                })
            )
        ).filter((p): p is ProjectSummary => p !== null);

        if (skipped > 0) {
            ctx.logger.warn({ skipped, total: rows.length }, 'projects.list: skipped undecryptable rows');
        }
        return { projects };
    }
});

export const projectCountFeature = defineSdkFeature({
    ...projectCount,
    handler: async (ctx: Ctx) => ({ count: await ctx.repo.projects.countActiveByWorkspace(ctx.workspaceId) })
});

export const projectGetFeature = defineSdkFeature({
    ...projectGet,
    handler: async (ctx: Ctx, input) => {
        const row = await loadProject(ctx, input.projectId);
        // `decrypt` (et non `tryDecrypt`) : ici l'échec doit remonter en `locked`
        // pour que le client ouvre l'invite, au lieu de rendre un projet vide.
        return { project: await readProject(ctx, row) };
    }
});

export const projectAddFeature = defineSdkFeature({
    ...projectAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        assertGuardedAllowed(ctx, input.securityTier);
        const cipher = cipherFor(ctx, input.securityTier);
        const payload = toPayload(input.project, '');
        const row = await ctx.repo.projects.create({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            status: input.project.status,
            securityTier: input.securityTier,
            startDate: input.project.startDate,
            dueDate: input.project.dueDate,
            content: await encryptProject(cipher, payload)
        });
        // Le tableau naît utilisable. Les colonnes suivent l'étage du projet,
        // comme tout le reste de son arbre.
        for (const column of DEFAULT_COLUMNS) {
            await ctx.repo.board.createColumn({
                projectId: row.id,
                workspaceId: ctx.workspaceId,
                content: await encryptColumn(cipher, { name: column.name }),
                countsAsDone: column.countsAsDone
            });
        }

        await recordEvent(ctx, row, { kind: 'projects.created', label: payload.title });
        ctx.audit({
            action: 'projects.create',
            description: 'Projet créé',
            metadata: { projectId: row.id, securityTier: input.securityTier }
        });
        return { project: toProject(row, payload) };
    }
});

export const projectUpdateFeature = defineSdkFeature({
    ...projectUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const existing = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, existing);

        const cipher = cipherFor(ctx, existing.security_tier);
        // La version n'est pas dans le brouillon : on relit celle en place pour
        // qu'une édition du profil n'écrase jamais une valeur synchronisée.
        const previous = await decryptProject(cipher, existing.content);
        if (!previous) throw new FeatureError('internal', 'Le corps du projet est illisible');

        const payload = toPayload(input.project, previous.version);
        const row = await ctx.repo.projects.update(input.projectId, ctx.workspaceId, {
            status: input.project.status,
            startDate: input.project.startDate,
            dueDate: input.project.dueDate,
            content: await encryptProject(cipher, payload)
        });
        if (!row) throw new FeatureError('not_found', 'Projet introuvable');

        // Seuls les changements qu'on cherche des mois plus tard entrent dans la
        // frise : un renommage ou un changement de statut, pas une retouche de
        // description.
        if (previous.title !== payload.title) {
            await recordEvent(ctx, row, {
                kind: 'projects.renamed',
                label: 'Projet renommé',
                from: previous.title,
                to: payload.title
            });
        }
        if (existing.status !== input.project.status) {
            await recordEvent(ctx, row, {
                kind: 'projects.status',
                label: 'Statut modifié',
                from: existing.status,
                to: input.project.status
            });
        }
        return { project: toProject(row, payload) };
    }
});

export const projectSetStatusFeature = defineSdkFeature({
    ...projectSetStatus,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const existing = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, existing);
        const row = await ctx.repo.projects.setStatus(input.projectId, ctx.workspaceId, input.status);
        if (!row) throw new FeatureError('not_found', 'Projet introuvable');
        if (existing.status !== input.status) {
            await recordEvent(ctx, row, {
                kind: 'projects.status',
                label: 'Statut modifié',
                from: existing.status,
                to: input.status
            });
        }
        return { project: await readProject(ctx, row) };
    }
});

export const projectSetVersionFeature = defineSdkFeature({
    ...projectSetVersion,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const existing = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, existing);

        // Un projet gardé ne se synchronise pas : le service de fond du module
        // Git lit sans session, il n'atteindra jamais l'étage gardé. Refus
        // explicite plutôt qu'un réglage qui ne ferait rien.
        if (input.source === 'github_release' && existing.security_tier === 'guarded') {
            throw new FeatureError(
                'validation',
                'Un projet confidentiel ne peut pas suivre les releases : sa synchronisation automatique est impossible.'
            );
        }

        const cipher = cipherFor(ctx, existing.security_tier);
        const previous = await decryptProject(cipher, existing.content);
        if (!previous) throw new FeatureError('internal', 'Le corps du projet est illisible');

        // En mode `github_release` le numéro appartient au module Git (par le
        // contrat d'usage, `applyVersion`) : on garde celui en place et on
        // ignore ce que demande le client.
        const version = input.source === 'github_release' ? previous.version : input.version;
        const payload: StoredProject = { ...previous, version };

        const updated = await ctx.repo.projects.update(input.projectId, ctx.workspaceId, {
            status: existing.status,
            startDate: existing.start_date,
            dueDate: existing.due_date,
            content: await encryptProject(cipher, payload)
        });
        if (!updated) throw new FeatureError('not_found', 'Projet introuvable');
        const row = await ctx.repo.projects.setVersionSource(input.projectId, ctx.workspaceId, input.source);
        if (!row) throw new FeatureError('not_found', 'Projet introuvable');
        if (previous.version !== version) {
            await recordEvent(ctx, row, {
                kind: 'projects.version',
                label: 'Version modifiée',
                from: previous.version || null,
                to: version || null
            });
        }
        return { project: toProject(row, payload) };
    }
});

export const projectSetSecurityTierFeature = defineSdkFeature({
    ...projectSetSecurityTier,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const existing = await loadProject(ctx, input.projectId);
        assertGuardedAllowed(ctx, input.securityTier);

        if (existing.security_tier === input.securityTier) {
            return { project: await readProject(ctx, existing) };
        }

        // Déverrouillage exigé dans les deux sens : on ne re-chiffre pas ce
        // qu'on ne peut pas lire, et on n'écrit pas sous une clé qu'on n'a pas.
        if (!(await ctx.secrecy.isUnlocked())) {
            throw new FeatureError(
                'locked',
                'Le chiffrement par mot de passe est verrouillé ; saisissez-le pour convertir ce projet'
            );
        }

        // Passer en confidentiel retire les liaisons aux objets d'espace. Elles
        // sont en clair par construction (le dépôt, la base, le site, la cible
        // appartiennent à l'espace, pas au projet) : rattacher un projet
        // confidentiel à un dépôt nommé montrerait précisément ce que le palier
        // est censé cacher, et les services de fond de ces modules lisent sans
        // session. Les objets, leur cache et les autres projets qui s'en
        // servent ne sont pas touchés : seules les liaisons tombent.
        //
        // Fait **avant** la conversion, pour que les événements de frise soient
        // enregistrés sous l'ancien tier, celui sous lequel le reste de
        // l'historique du projet a été écrit.
        if (input.securityTier === 'guarded') {
            const repos = await ctx.repo.links.unlinkAllRepos(input.projectId, ctx.workspaceId);
            if (repos > 0) {
                await recordEvent(ctx, existing, {
                    kind: 'projects.repoUnlink',
                    label: `${repos} dépôt${repos > 1 ? 's' : ''} git délié${repos > 1 ? 's' : ''} (projet passé en confidentiel)`
                });
            }

            const databases = await ctx.repo.links.listDatabaseIds(input.projectId, ctx.workspaceId);
            if (databases.length > 0) {
                await ctx.repo.links.unlinkAllDatabases(input.projectId, ctx.workspaceId);
                await recordEvent(ctx, existing, {
                    kind: 'projects.databaseUnlink',
                    label: `${databases.length} base${databases.length > 1 ? 's' : ''} déliée${databases.length > 1 ? 's' : ''} (projet passé en confidentiel)`
                });
            }

            const sites = await ctx.repo.links.listSiteIds(input.projectId, ctx.workspaceId);
            if (sites.length > 0) {
                await ctx.repo.links.unlinkAllSites(input.projectId, ctx.workspaceId);
                await recordEvent(ctx, existing, {
                    kind: 'projects.audienceUnlink',
                    label: `${sites.length} site${sites.length > 1 ? 's' : ''} de suivi délié${sites.length > 1 ? 's' : ''} (projet passé en confidentiel)`
                });
            }

            const targets = await ctx.repo.links.unlinkAllDeployTargets(input.projectId, ctx.workspaceId);
            if (targets > 0) {
                await recordEvent(ctx, existing, {
                    kind: 'projects.deployUnlink',
                    label: `${targets} cible${targets > 1 ? 's' : ''} de déploiement déliée${targets > 1 ? 's' : ''} (projet passé en confidentiel)`
                });
            }
        }

        const from = cipherFor(ctx, existing.security_tier);
        const to = cipherFor(ctx, input.securityTier);
        const content = await reencryptProjectTree(ctx, existing, from, to);

        const row = await ctx.repo.projects.setSecurityTier(
            input.projectId,
            ctx.workspaceId,
            input.securityTier,
            content
        );
        if (!row) throw new FeatureError('not_found', 'Projet introuvable');

        // Passer en gardé coupe les intégrations : elles lisent sans session.
        const settled =
            input.securityTier === 'guarded' && row.version_source === 'github_release'
                ? await ctx.repo.projects.setVersionSource(input.projectId, ctx.workspaceId, 'manual')
                : row;
        if (!settled) throw new FeatureError('not_found', 'Projet introuvable');

        await recordEvent(ctx, settled, {
            kind: 'projects.securityTier',
            label: 'Confidentialité modifiée',
            from: existing.security_tier,
            to: input.securityTier
        });
        ctx.audit({
            action: 'projects.setSecurityTier',
            description: `Projet converti en ${input.securityTier === 'guarded' ? 'confidentiel' : 'standard'}`,
            metadata: { projectId: settled.id, from: existing.security_tier, to: input.securityTier }
        });
        return { project: await readProject(ctx, settled) };
    }
});

export const projectArchiveFeature = defineSdkFeature({
    ...projectArchive,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const existing = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, existing);
        const ok = await ctx.repo.projects.archive(input.projectId, ctx.workspaceId, Math.floor(Date.now() / 1000));
        if (!ok) throw new FeatureError('not_found', 'Projet introuvable');
        await recordEvent(ctx, existing, { kind: 'projects.archived', label: 'Projet archivé' });
        ctx.audit({
            action: 'projects.archive',
            description: 'Projet archivé',
            metadata: { projectId: input.projectId }
        });
        return { projectId: input.projectId };
    }
});

export const projectRestoreFeature = defineSdkFeature({
    ...projectRestore,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const existing = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, existing);
        const ok = await ctx.repo.projects.restore(input.projectId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Projet introuvable');
        await recordEvent(ctx, existing, { kind: 'projects.restored', label: 'Projet restauré' });
        return { projectId: input.projectId };
    }
});

export const projectReorderFeature = defineSdkFeature({
    ...projectReorder,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        // Ne touche jamais au corps chiffré : fonctionne donc aussi sur des
        // projets masqués, session verrouillée.
        await ctx.repo.projects.reorder(ctx.workspaceId, input.projectIds);
        return { projectIds: input.projectIds };
    }
});

export const projectPortfolioFeatures = [
    projectListFeature,
    projectCountFeature,
    projectGetFeature,
    projectAddFeature,
    projectUpdateFeature,
    projectSetStatusFeature,
    projectSetVersionFeature,
    projectSetSecurityTierFeature,
    projectArchiveFeature,
    projectRestoreFeature,
    projectReorderFeature
];
