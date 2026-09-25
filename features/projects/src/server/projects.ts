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
    assertAtHome,
    assertGuardedAllowed,
    assertProjectUnlocked,
    cipherFor,
    decryptProject,
    encryptColumn,
    encryptProject,
    isForeign,
    loadProject,
    MANAGE,
    projectCipher,
    recordEvent,
    reencryptProjectTree,
    toMaskedSummary,
    toProject,
    toSummary,
    tryDecryptProject,
    type Ctx,
    type StoredProject
} from './_shared';
import { forgetPublicPage } from './publication';

/**
 * Le portefeuille : les projets de l'espace actif, plus ceux qu'un autre espace y
 * projette. Un projet projeté (`Docs/SHARING.md`) se lit et son arbre s'écrit chez
 * lui, sous le codec ouvert de son domicile, mais les droits restent ceux de
 * l'espace actif, restriction par élément comprise. Depuis la fenêtre, tout se fait
 * sauf ce qui référence d'autres objets de l'espace d'origine (`assertAtHome`).
 */

/**
 * Colonnes posées d'office : un tableau sans colonne est une impasse, aucune carte
 * ne peut y naître. La dernière porte `countsAsDone`, ce qui rend l'avancement du
 * projet calculable dès la première carte.
 */
const DEFAULT_COLUMNS: { name: string; countsAsDone: boolean }[] = [
    { name: 'À faire', countsAsDone: false },
    { name: 'En cours', countsAsDone: false },
    { name: 'Terminé', countsAsDone: true }
];

function toPayload(draft: ProjectDraft, version: string): StoredProject {
    return {
        title: draft.title,
        icon: draft.icon,
        description: draft.description,
        tags: draft.tags,
        version,
        timelineZoom: draft.timelineZoom
    };
}

/** Relit une ligne fraîchement écrite, sous son codec, pour la renvoyer entière. */
async function readProject(ctx: Ctx, row: ProjectRow) {
    const payload = await decryptProject(await projectCipher(ctx, row), row.content);
    if (!payload) throw new FeatureError('internal', 'Le corps du projet est illisible');
    return toProject(row, payload, isForeign(ctx, row));
}

export const projectListFeature = defineSdkFeature({
    ...projectList,
    handler: async (ctx: Ctx, input) => {
        const wantArchived = input.archived === true;
        const [visible, hidden, scope] = await Promise.all([
            ctx.repo.projects.listVisible(ctx.workspaceId, wantArchived),
            ctx.items.restrictions(),
            ctx.sharing.scope()
        ]);
        // Les projets qu'une restriction masque disparaissent de la liste plutôt
        // que d'y figurer grisés : une ligne qu'on voit apprend déjà qu'elle existe.
        const rows = visible.filter((r) => hidden.get(String(r.id)) !== 'none');

        // Les compteurs ne dépendent d'aucune clé : ils s'affichent même sur un
        // projet gardé qu'on ne sait pas déchiffrer. Les non-lus sont ceux de
        // l'appelant, chez lui comme par une fenêtre.
        const stats = new Map(
            (
                await ctx.repo.projects.statsFor(
                    rows.map((r) => r.id),
                    ctx.userId,
                    Math.floor(Date.now() / 1000)
                )
            ).map((s) => [s.project_id, s])
        );

        // Un projet gardé n'est révélé que si la DEK est déjà vivante, et la
        // question n'est posée (elle fait glisser la fenêtre de grâce) que s'il y a
        // vraiment un projet gardé à révéler.
        const canReadGuarded = rows.some((r) => r.security_tier === 'guarded') ? await ctx.secrecy.isUnlocked() : false;

        let skipped = 0;
        const projects = (
            await Promise.all(
                rows.map(async (row): Promise<ProjectSummary | null> => {
                    const guarded = row.security_tier === 'guarded';
                    if (guarded && !canReadGuarded) return toMaskedSummary(row, stats.get(row.id));
                    // Un projet projeté reste chiffré sous la clé de son espace
                    // d'origine, d'où un codec choisi projet par projet.
                    const payload = await tryDecryptProject(await projectCipher(ctx, row, scope), row.content);
                    if (!payload) {
                        // Ligne corrompue, ou clé qui ne correspond plus : mise de
                        // côté plutôt que de faire échouer toute la liste.
                        skipped += 1;
                        return null;
                    }
                    return toSummary(row, payload, stats.get(row.id), isForeign(ctx, row));
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
    handler: async (ctx: Ctx) => {
        // Les mêmes lignes que la liste, comptées sur les métadonnées claires :
        // aucune DEK, aucun verrou. Une tuile qui compte autre chose que la liste
        // qu'elle ouvre se lit comme un bug.
        const [visible, hidden] = await Promise.all([
            ctx.repo.projects.listVisible(ctx.workspaceId, false),
            ctx.items.restrictions()
        ]);
        return { count: visible.filter((r) => hidden.get(String(r.id)) !== 'none').length };
    }
});

export const projectGetFeature = defineSdkFeature({
    ...projectGet,
    handler: async (ctx: Ctx, input) => {
        const row = await loadProject(ctx, input.projectId);
        // `decrypt` et non `tryDecrypt` : l'échec doit remonter en `locked` pour
        // que le client ouvre l'invite, au lieu de rendre un projet vide.
        return { project: await readProject(ctx, row) };
    }
});

export const projectAddFeature = defineSdkFeature({
    ...projectAdd,
    mutates: true,
    access: MANAGE,
    handler: async (ctx: Ctx, input) => {
        assertGuardedAllowed(ctx, input.securityTier);
        const cipher = cipherFor(ctx, input.securityTier);
        const payload = toPayload(input.project, '');
        const row = await ctx.repo.projects.create({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            status: input.project.status,
            showOverview: input.project.showOverview,
            showTimeline: input.project.showTimeline,
            securityTier: input.securityTier,
            startDate: input.project.startDate,
            dueDate: input.project.dueDate,
            content: await encryptProject(cipher, payload)
        });
        // Les colonnes suivent l'étage du projet, comme tout le reste de son arbre.
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
        return { project: toProject(row, payload, false) };
    }
});

export const projectUpdateFeature = defineSdkFeature({
    ...projectUpdate,
    mutates: true,
    access: MANAGE,
    handler: async (ctx: Ctx, input) => {
        const existing = await loadProject(ctx, input.projectId, 'write');
        await assertProjectUnlocked(ctx, existing);

        // Le profil se réécrit d'où l'on est, mais chez lui : codec et ligne du
        // domicile.
        const cipher = await projectCipher(ctx, existing);
        // La version n'est pas dans le brouillon : on relit celle en place pour
        // qu'une édition du profil n'écrase jamais une valeur synchronisée.
        const previous = await decryptProject(cipher, existing.content);
        if (!previous) throw new FeatureError('internal', 'Le corps du projet est illisible');

        const payload = toPayload(input.project, previous.version);
        const row = await ctx.repo.projects.update(input.projectId, existing.workspace_id, {
            status: input.project.status,
            showOverview: input.project.showOverview,
            showTimeline: input.project.showTimeline,
            startDate: input.project.startDate,
            dueDate: input.project.dueDate,
            content: await encryptProject(cipher, payload)
        });
        if (!row) throw new FeatureError('not_found', 'Projet introuvable');

        // Seuls les changements qu'on cherche des mois plus tard entrent dans la
        // frise : un renommage ou un statut, pas une retouche de description.
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
        return { project: toProject(row, payload, isForeign(ctx, row)) };
    }
});

export const projectSetStatusFeature = defineSdkFeature({
    ...projectSetStatus,
    mutates: true,
    access: MANAGE,
    handler: async (ctx: Ctx, input) => {
        const existing = await loadProject(ctx, input.projectId, 'write');
        await assertProjectUnlocked(ctx, existing);
        const row = await ctx.repo.projects.setStatus(input.projectId, existing.workspace_id, input.status);
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
    access: MANAGE,
    handler: async (ctx: Ctx, input) => {
        const existing = await loadProject(ctx, input.projectId, 'write');
        await assertProjectUnlocked(ctx, existing);

        if (input.source === 'github_release') {
            // Suivre les releases référence un dépôt de l'espace d'origine, que la
            // fenêtre ne voit pas ; une version manuelle se pose d'où l'on est.
            assertAtHome(ctx, existing, 'le suivi des releases');
            // Le service de fond du module Git lit sans session : il n'atteindra
            // jamais l'étage gardé. Refus explicite plutôt qu'un réglage sans effet.
            if (existing.security_tier === 'guarded') {
                throw new FeatureError(
                    'validation',
                    'Un projet confidentiel ne peut pas suivre les releases : sa synchronisation automatique est impossible.'
                );
            }
        }

        const cipher = await projectCipher(ctx, existing);
        const previous = await decryptProject(cipher, existing.content);
        if (!previous) throw new FeatureError('internal', 'Le corps du projet est illisible');

        // En `github_release` le numéro appartient au module Git (`applyVersion`) :
        // on garde celui en place et on ignore ce que demande le client.
        const version = input.source === 'github_release' ? previous.version : input.version;
        const payload: StoredProject = { ...previous, version };

        const updated = await ctx.repo.projects.update(input.projectId, existing.workspace_id, {
            status: existing.status,
            showOverview: existing.show_overview === 1,
            showTimeline: existing.show_timeline === 1,
            startDate: existing.start_date,
            dueDate: existing.due_date,
            content: await encryptProject(cipher, payload)
        });
        if (!updated) throw new FeatureError('not_found', 'Projet introuvable');
        const row = await ctx.repo.projects.setVersionSource(input.projectId, existing.workspace_id, input.source);
        if (!row) throw new FeatureError('not_found', 'Projet introuvable');
        if (previous.version !== version) {
            await recordEvent(ctx, row, {
                kind: 'projects.version',
                label: 'Version modifiée',
                from: previous.version || null,
                to: version || null
            });
        }
        return { project: toProject(row, payload, isForeign(ctx, row)) };
    }
});

export const projectSetSecurityTierFeature = defineSdkFeature({
    ...projectSetSecurityTier,
    mutates: true,
    access: MANAGE,
    handler: async (ctx: Ctx, input) => {
        const existing = await loadProject(ctx, input.projectId, 'write');
        // Le palier relie l'arbre au mot de passe d'un membre de l'espace
        // d'origine : il se règle là-bas, quel que soit le sens de la bascule.
        assertAtHome(ctx, existing, 'la confidentialité');
        assertGuardedAllowed(ctx, input.securityTier);
        const home = existing.workspace_id;

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

        // Passer en confidentiel retire les liaisons aux objets d'espace, en clair
        // par construction : rattacher un projet confidentiel à un dépôt nommé
        // montrerait ce que le palier est censé cacher. Seules les liaisons tombent,
        // pas les objets ni les autres projets qui s'en servent.
        //
        // Avant la conversion, pour que les événements de frise soient écrits sous
        // l'ancien palier, celui du reste de l'historique du projet.
        if (input.securityTier === 'guarded') {
            const repos = await ctx.repo.links.unlinkAllRepos(input.projectId, home);
            if (repos > 0) {
                await recordEvent(ctx, existing, {
                    kind: 'projects.repoUnlink',
                    label: `${repos} dépôt${repos > 1 ? 's' : ''} git délié${repos > 1 ? 's' : ''} (projet passé en confidentiel)`
                });
            }

            const databases = await ctx.repo.links.listDatabaseIds(input.projectId, home);
            if (databases.length > 0) {
                await ctx.repo.links.unlinkAllDatabases(input.projectId, home);
                await recordEvent(ctx, existing, {
                    kind: 'projects.databaseUnlink',
                    label: `${databases.length} base${databases.length > 1 ? 's' : ''} déliée${databases.length > 1 ? 's' : ''} (projet passé en confidentiel)`
                });
            }

            const sites = await ctx.repo.links.listSiteIds(input.projectId, home);
            if (sites.length > 0) {
                await ctx.repo.links.unlinkAllSites(input.projectId, home);
                await recordEvent(ctx, existing, {
                    kind: 'projects.audienceUnlink',
                    label: `${sites.length} site${sites.length > 1 ? 's' : ''} de suivi délié${sites.length > 1 ? 's' : ''} (projet passé en confidentiel)`
                });
            }

            const targets = await ctx.repo.links.unlinkAllDeployTargets(input.projectId, home);
            if (targets > 0) {
                await recordEvent(ctx, existing, {
                    kind: 'projects.deployUnlink',
                    label: `${targets} cible${targets > 1 ? 's' : ''} de déploiement déliée${targets > 1 ? 's' : ''} (projet passé en confidentiel)`
                });
            }

            // La page publique tombe, lien compris : un lien donné comme public ne
            // doit jamais rouvrir un projet devenu confidentiel.
            if (await ctx.repo.publication.remove(input.projectId)) {
                forgetPublicPage(input.projectId);
                await recordEvent(ctx, existing, {
                    kind: 'projects.publication',
                    label: 'Page publique fermée (projet passé en confidentiel)'
                });
            }
        }

        const from = cipherFor(ctx, existing.security_tier);
        const to = cipherFor(ctx, input.securityTier);
        const content = await reencryptProjectTree(ctx, existing, from, to);

        const row = await ctx.repo.projects.setSecurityTier(input.projectId, home, input.securityTier, content);
        if (!row) throw new FeatureError('not_found', 'Projet introuvable');

        // Passer en gardé coupe les intégrations : elles lisent sans session.
        const settled =
            input.securityTier === 'guarded' && row.version_source === 'github_release'
                ? await ctx.repo.projects.setVersionSource(input.projectId, home, 'manual')
                : row;
        if (!settled) throw new FeatureError('not_found', 'Projet introuvable');

        // Un projet gardé ne se lit que chez son auteur : ses projections n'ont plus
        // d'objet, et `ctx.items.forget` les retire avec les restrictions par
        // élément, sans perte puisqu'un projet gardé vit dans un espace personnel.
        // Sans ce ménage, une ligne `item_shares` dormante remontrerait le projet le
        // jour où il rouvre.
        if (input.securityTier === 'guarded') await ctx.items.forget(String(input.projectId));

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
    access: MANAGE,
    handler: async (ctx: Ctx, input) => {
        const existing = await loadProject(ctx, input.projectId, 'write');
        await assertProjectUnlocked(ctx, existing);
        // Chez lui, même depuis une fenêtre : le projet quitte toutes ses fenêtres
        // à la fois.
        const ok = await ctx.repo.projects.archive(
            input.projectId,
            existing.workspace_id,
            Math.floor(Date.now() / 1000)
        );
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
    access: MANAGE,
    handler: async (ctx: Ctx, input) => {
        const existing = await loadProject(ctx, input.projectId, 'write');
        await assertProjectUnlocked(ctx, existing);
        const ok = await ctx.repo.projects.restore(input.projectId, existing.workspace_id);
        if (!ok) throw new FeatureError('not_found', 'Projet introuvable');
        await recordEvent(ctx, existing, { kind: 'projects.restored', label: 'Projet restauré' });
        return { projectId: input.projectId };
    }
});

export const projectReorderFeature = defineSdkFeature({
    ...projectReorder,
    mutates: true,
    access: MANAGE,
    handler: async (ctx: Ctx, input) => {
        // Un projet projeté se classe chez lui. Refus franc plutôt qu'abandon
        // silencieux : le client ne le propose pas au glisser, un appel qui l'inclut
        // est une erreur qu'il vaut mieux voir.
        const [scope, hidden] = await Promise.all([ctx.sharing.scope(), ctx.items.restrictions()]);
        if (input.projectIds.some((id) => scope.foreignIds.has(String(id)))) {
            throw new FeatureError(
                'validation',
                'Un projet partagé depuis un autre espace se classe chez lui, pas ici.'
            );
        }
        // Un projet que ce rôle ne peut pas écrire est laissé de côté en silence :
        // c'est le portefeuille d'ici qu'on range, avec ce qu'on y voit.
        const projectIds = input.projectIds.filter((id) => !hidden.has(String(id)));
        // Ne touche jamais au corps chiffré : fonctionne sur des projets masqués.
        await ctx.repo.projects.reorder(ctx.workspaceId, projectIds);
        return { projectIds };
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
