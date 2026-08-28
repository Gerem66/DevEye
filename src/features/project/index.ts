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
} from '@deveye/types';
import type { ProjectDraft, ProjectSummary } from '@deveye/types';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import type { FeatureContext } from '../_define';
import { projectBoardFeatures } from './board';
import { projectChatFeatures } from './chat';
import { projectTimelineFeatures } from './timeline';
import { projectHistoryFeatures } from './history';
import { projectDatabaseLinkFeatures } from './databaseLink';
import { projectAudienceLinkFeatures } from './audienceLink';
import { projectRepoLinkFeatures } from './repoLink';
import { projectDeployLinkFeatures } from './deployLink';
import { projectLinkFeatures } from './links';
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
    type StoredProject
} from './_shared';

/**
 * Projets, scopés à l'espace actif.
 *
 * L'espace vient de l'enveloppe WS et l'appartenance est déjà vérifiée par le
 * dispatcheur : les handlers filtrent sur `ctx.workspaceId`, sans garde ni
 * traduction d'id.
 *
 * ⚠️ Le contrôle de démarrage de `_topics.ts` qui attrape un `mutates` oublié
 * cherche un verbe **juste après le point** (`notes.add`). Les commandes d'ici
 * sont en camelCase sous un préfixe unique (`project.setStatus`) : il n'en verra
 * aucune. `mutates` est donc à relire à la main sur toute écriture ajoutée ici.
 */

const READ = { feature: 'projects' } as const;
const WRITE = { feature: 'projects', level: 'write' } as const;

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

export const projectListFeature: FeatureDefinition<
    typeof projectList.command,
    typeof projectList.input,
    typeof projectList.output
> = defineFeature({
    ...projectList,
    access: READ,
    handler: async (ctx, input) => {
        const wantArchived = input.archived === true;
        const rows = await ctx.db.projects.listByWorkspace(ctx.workspaceId, wantArchived);

        // Compteurs d'abord : ils ne dépendent d'aucune clé, et doivent donc
        // s'afficher même sur un projet gardé qu'on ne sait pas déchiffrer.
        const stats = new Map(
            (await ctx.db.projects.statsByWorkspace(ctx.workspaceId, ctx.userId, Math.floor(Date.now() / 1000))).map(
                (s) => [s.project_id, s]
            )
        );

        // Jamais bloquée : la liste s'affiche toujours. Un projet gardé n'est
        // révélé que si la DEK est déjà vivante — et on ne le demande (ce qui
        // fait glisser la fenêtre de grâce) que s'il y a vraiment un projet
        // gardé à révéler.
        const canReadGuarded = rows.some((r) => r.security_tier === 'guarded') ? await ctx.secure.isUnlocked() : false;

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
            ctx.logger.warn({ skipped, total: rows.length }, 'project.list: skipped undecryptable rows');
        }
        return { projects };
    }
});

export const projectCountFeature: FeatureDefinition<
    typeof projectCount.command,
    typeof projectCount.input,
    typeof projectCount.output
> = defineFeature({
    ...projectCount,
    access: READ,
    handler: async (ctx) => ({ count: await ctx.db.projects.countActiveByWorkspace(ctx.workspaceId) })
});

export const projectGetFeature: FeatureDefinition<
    typeof projectGet.command,
    typeof projectGet.input,
    typeof projectGet.output
> = defineFeature({
    ...projectGet,
    access: READ,
    handler: async (ctx, input) => {
        const row = await loadProject(ctx, input.projectId);
        // `decrypt` (et non `tryDecrypt`) : ici l'échec doit remonter en `locked`
        // pour que le client ouvre l'invite, au lieu de rendre un projet vide.
        const payload = await decryptProject(cipherFor(ctx, row.security_tier), row.content);
        if (!payload) throw new FeatureError('internal', 'Le corps du projet est illisible');
        return { project: toProject(row, payload) };
    }
});

export const projectAddFeature: FeatureDefinition<
    typeof projectAdd.command,
    typeof projectAdd.input,
    typeof projectAdd.output
> = defineFeature({
    ...projectAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        assertGuardedAllowed(ctx, input.securityTier);
        const payload = toPayload(input.project, '');
        const content = await encryptProject(cipherFor(ctx, input.securityTier), payload);
        const row = await ctx.db.projects.create({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            status: input.project.status,
            securityTier: input.securityTier,
            startDate: input.project.startDate,
            dueDate: input.project.dueDate,
            content
        });
        // Le tableau naît utilisable. Les colonnes suivent l'étage du projet,
        // comme tout le reste de son arbre.
        const cipher = cipherFor(ctx, input.securityTier);
        for (const column of DEFAULT_COLUMNS) {
            await ctx.db.projectBoard.createColumn({
                projectId: row.id,
                workspaceId: ctx.workspaceId,
                content: await encryptColumn(cipher, { name: column.name }),
                countsAsDone: column.countsAsDone
            });
        }

        await recordEvent(ctx, row, { kind: 'project.created', label: payload.title });
        ctx.audit({
            action: 'project.create',
            description: 'Projet créé',
            metadata: { projectId: row.id, securityTier: input.securityTier }
        });
        return { project: toProject(row, payload) };
    }
});

export const projectUpdateFeature: FeatureDefinition<
    typeof projectUpdate.command,
    typeof projectUpdate.input,
    typeof projectUpdate.output
> = defineFeature({
    ...projectUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const existing = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, existing);

        const cipher = cipherFor(ctx, existing.security_tier);
        // La version n'est pas dans le brouillon : on relit celle en place pour
        // qu'une édition du profil n'écrase jamais une valeur synchronisée.
        const previous = await decryptProject(cipher, existing.content);
        if (!previous) throw new FeatureError('internal', 'Le corps du projet est illisible');

        const payload = toPayload(input.project, previous.version);
        const row = await ctx.db.projects.update(input.projectId, ctx.workspaceId, {
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
                kind: 'project.renamed',
                label: 'Projet renommé',
                from: previous.title,
                to: payload.title
            });
        }
        if (existing.status !== input.project.status) {
            await recordEvent(ctx, row, {
                kind: 'project.status',
                label: 'Statut modifié',
                from: existing.status,
                to: input.project.status
            });
        }
        return { project: toProject(row, payload) };
    }
});

export const projectSetStatusFeature: FeatureDefinition<
    typeof projectSetStatus.command,
    typeof projectSetStatus.input,
    typeof projectSetStatus.output
> = defineFeature({
    ...projectSetStatus,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const existing = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, existing);
        const row = await ctx.db.projects.setStatus(input.projectId, ctx.workspaceId, input.status);
        if (!row) throw new FeatureError('not_found', 'Projet introuvable');
        if (existing.status !== input.status) {
            await recordEvent(ctx, row, {
                kind: 'project.status',
                label: 'Statut modifié',
                from: existing.status,
                to: input.status
            });
        }
        return { project: await readProject(ctx, row) };
    }
});

export const projectSetVersionFeature: FeatureDefinition<
    typeof projectSetVersion.command,
    typeof projectSetVersion.input,
    typeof projectSetVersion.output
> = defineFeature({
    ...projectSetVersion,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const existing = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, existing);

        // Un projet gardé ne se synchronise pas : le service de fond lit sans
        // session, il n'atteindra jamais l'étage gardé. Refus explicite plutôt
        // qu'un réglage qui ne ferait rien.
        if (input.source === 'github_release' && existing.security_tier === 'guarded') {
            throw new FeatureError(
                'validation',
                'Un projet confidentiel ne peut pas suivre les releases : sa synchronisation automatique est impossible.'
            );
        }

        const cipher = cipherFor(ctx, existing.security_tier);
        const previous = await decryptProject(cipher, existing.content);
        if (!previous) throw new FeatureError('internal', 'Le corps du projet est illisible');

        // En mode `github_release` le numéro appartient au service de fond : on
        // garde celui en place et on ignore ce que demande le client.
        const version = input.source === 'github_release' ? previous.version : input.version;
        const payload: StoredProject = { ...previous, version };

        const updated = await ctx.db.projects.update(input.projectId, ctx.workspaceId, {
            status: existing.status,
            startDate: existing.start_date,
            dueDate: existing.due_date,
            content: await encryptProject(cipher, payload)
        });
        if (!updated) throw new FeatureError('not_found', 'Projet introuvable');
        const row = await ctx.db.projects.setVersionSource(input.projectId, ctx.workspaceId, input.source);
        if (!row) throw new FeatureError('not_found', 'Projet introuvable');
        if (previous.version !== version) {
            await recordEvent(ctx, row, {
                kind: 'project.version',
                label: 'Version modifiée',
                from: previous.version || null,
                to: version || null
            });
        }
        return { project: toProject(row, payload) };
    }
});

export const projectSetSecurityTierFeature: FeatureDefinition<
    typeof projectSetSecurityTier.command,
    typeof projectSetSecurityTier.input,
    typeof projectSetSecurityTier.output
> = defineFeature({
    ...projectSetSecurityTier,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const existing = await loadProject(ctx, input.projectId);
        assertGuardedAllowed(ctx, input.securityTier);

        if (existing.security_tier === input.securityTier) {
            return { project: await readProject(ctx, existing) };
        }

        // Déverrouillage exigé dans les deux sens : on ne re-chiffre pas ce
        // qu'on ne peut pas lire, et on n'écrit pas sous une clé qu'on n'a pas.
        if (!(await ctx.secure.isUnlocked())) {
            throw new FeatureError(
                'locked',
                'Le chiffrement par mot de passe est verrouillé ; saisissez-le pour convertir ce projet'
            );
        }

        // Passer en confidentiel retire la liaison au dépôt. Elle est en clair
        // par construction (le dépôt appartient à l'espace, pas au projet) :
        // rattacher un projet confidentiel à un dépôt nommé montrerait
        // précisément ce que le palier est censé cacher. Le dépôt, son cache et
        // les autres projets qui s'en servent ne sont pas touchés.
        //
        // Fait **avant** la conversion, pour que l'événement de frise soit
        // enregistré sous l'ancien tier — celui sous lequel le reste de
        // l'historique du projet a été écrit.
        if (input.securityTier === 'guarded') {
            const dropped = await ctx.db.git.unlinkAllProjects(input.projectId, ctx.workspaceId);
            if (dropped > 0) {
                await recordEvent(ctx, existing, {
                    kind: 'project.repoUnlink',
                    label: `${dropped} dépôt${dropped > 1 ? 's' : ''} git délié${dropped > 1 ? 's' : ''} (projet passé en confidentiel)`
                });
            }
        }

        // Même règle pour les bases de données, et pour la même raison : elles
        // vivent à l'étage ouvert, et le relevé périodique les lit sans session.
        // Les bases et leurs alertes survivent — seules les liaisons tombent.
        if (input.securityTier === 'guarded') {
            const linked = await ctx.db.projectLinks.listDatabaseIds(input.projectId, ctx.workspaceId);
            if (linked.length > 0) {
                await ctx.db.projectLinks.unlinkAllDatabases(input.projectId, ctx.workspaceId);
                await recordEvent(ctx, existing, {
                    kind: 'project.databaseUnlink',
                    label: `${linked.length} base${linked.length > 1 ? 's' : ''} déliée${linked.length > 1 ? 's' : ''} (projet passé en confidentiel)`
                });
            }
        }

        // Et pour les sites suivis, troisième fois la même règle. Elle vaut
        // pour tout objet **d'espace** qu'un projet ne fait que pointer : la
        // liaison est en clair, l'objet vit à l'étage ouvert, et un service
        // sans session y travaille. Les sites et leur historique survivent.
        if (input.securityTier === 'guarded') {
            const sites = await ctx.db.audience.listLinkedIds(input.projectId, ctx.workspaceId);
            if (sites.length > 0) {
                await ctx.db.audience.unlinkAll(input.projectId, ctx.workspaceId);
                await recordEvent(ctx, existing, {
                    kind: 'project.audienceUnlink',
                    label: `${sites.length} site${sites.length > 1 ? 's' : ''} de suivi délié${sites.length > 1 ? 's' : ''} (projet passé en confidentiel)`
                });
            }
        }

        // Et pour les cibles de déploiement, quatrième fois la même règle
        // (migration 080). Les cibles, leur clé et leur historique survivent —
        // seules les liaisons tombent.
        if (input.securityTier === 'guarded') {
            const dropped = await ctx.db.deploy.unlinkAllProjects(input.projectId, ctx.workspaceId);
            if (dropped > 0) {
                await recordEvent(ctx, existing, {
                    kind: 'project.deployUnlink',
                    label: `${dropped} cible${dropped > 1 ? 's' : ''} de déploiement déliée${dropped > 1 ? 's' : ''} (projet passé en confidentiel)`
                });
            }
        }

        const from = cipherFor(ctx, existing.security_tier);
        const to = cipherFor(ctx, input.securityTier);
        const content = await reencryptProjectTree(ctx, existing, from, to);

        const row = await ctx.db.projects.setSecurityTier(
            input.projectId,
            ctx.workspaceId,
            input.securityTier,
            content
        );
        if (!row) throw new FeatureError('not_found', 'Projet introuvable');

        // Passer en gardé coupe les intégrations : elles lisent sans session.
        if (input.securityTier === 'guarded' && row.version_source === 'github_release') {
            await ctx.db.projects.setVersionSource(input.projectId, ctx.workspaceId, 'manual');
        }

        await recordEvent(ctx, row, {
            kind: 'project.securityTier',
            label: 'Confidentialité modifiée',
            from: existing.security_tier,
            to: input.securityTier
        });
        ctx.audit({
            action: 'project.setSecurityTier',
            description: `Projet converti en ${input.securityTier === 'guarded' ? 'confidentiel' : 'standard'}`,
            metadata: { projectId: row.id, from: existing.security_tier, to: input.securityTier }
        });
        return { project: await readProject(ctx, row) };
    }
});

export const projectArchiveFeature: FeatureDefinition<
    typeof projectArchive.command,
    typeof projectArchive.input,
    typeof projectArchive.output
> = defineFeature({
    ...projectArchive,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const existing = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, existing);
        const ok = await ctx.db.projects.archive(input.projectId, ctx.workspaceId, Math.floor(Date.now() / 1000));
        if (!ok) throw new FeatureError('not_found', 'Projet introuvable');
        await recordEvent(ctx, existing, { kind: 'project.archived', label: 'Projet archivé' });
        ctx.audit({
            action: 'project.archive',
            description: 'Projet archivé',
            metadata: { projectId: input.projectId }
        });
        return { projectId: input.projectId };
    }
});

export const projectRestoreFeature: FeatureDefinition<
    typeof projectRestore.command,
    typeof projectRestore.input,
    typeof projectRestore.output
> = defineFeature({
    ...projectRestore,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const existing = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, existing);
        const ok = await ctx.db.projects.restore(input.projectId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Projet introuvable');
        await recordEvent(ctx, existing, { kind: 'project.restored', label: 'Projet restauré' });
        return { projectId: input.projectId };
    }
});

export const projectReorderFeature: FeatureDefinition<
    typeof projectReorder.command,
    typeof projectReorder.input,
    typeof projectReorder.output
> = defineFeature({
    ...projectReorder,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        // Ne touche jamais au corps chiffré : fonctionne donc aussi sur des
        // projets masqués, session verrouillée.
        await ctx.db.projects.reorder(ctx.workspaceId, input.projectIds);
        return { projectIds: input.projectIds };
    }
});

/** Relit et déchiffre une ligne fraîchement écrite, pour la renvoyer entière. */
async function readProject(ctx: FeatureContext, row: Parameters<typeof toProject>[0]) {
    const payload = await decryptProject(cipherFor(ctx, row.security_tier), row.content);
    if (!payload) throw new FeatureError('internal', 'Le corps du projet est illisible');
    return toProject(row, payload);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const projectFeatures: FeatureDefinition<string, any, any>[] = [
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
    projectReorderFeature,
    ...projectBoardFeatures,
    ...projectChatFeatures,
    ...projectTimelineFeatures,
    ...projectHistoryFeatures,
    ...projectRepoLinkFeatures,
    ...projectDatabaseLinkFeatures,
    ...projectAudienceLinkFeatures,
    ...projectDeployLinkFeatures,
    ...projectLinkFeatures
];
