import { randomBytes } from 'node:crypto';

import { projectPublicationGet, projectPublicationRelink, projectPublish } from '../contracts/commands';
import {
    PROJECT_SLUG_MAX_LENGTH,
    PUBLIC_PATH,
    type ProjectPublication,
    type ProjectPublicationDraft,
    type ProjectPublicRow,
    type ProjectRow
} from '../contracts/domain';
import type { PageThemeChoice } from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError, type SdkDomain } from '@deveye/types/sdk/server';

import { assertAtHome, isForeign, loadProject, MANAGE, recordEvent, tryDecryptProject, type Ctx } from './_shared';
import type { PublicPages } from './publicPage/routes';
import { publicStockId } from './repo';

/**
 * La page publique d'un projet, côté réglages. Un geste du domicile, réservé à
 * qui gère le projet, et jamais sur un projet gardé : le serveur n'en a pas la
 * clé hors session.
 */

let pages: PublicPages | null = null;

/** Posé par le service à son démarrage, retiré à son arrêt. */
export function setPublicPages(next: PublicPages | null): void {
    pages = next;
}

/** Le tableau public du projet se recalcule à la prochaine visite. */
export function forgetPublicPage(projectId: number): void {
    pages?.forget(projectId);
}

const now = () => Math.floor(Date.now() / 1000);

function newPublicRef(): string {
    return randomBytes(8).toString('hex');
}

/** Le chemin d'un projet sous un domaine, tiré de son titre : minuscules, chiffres et tirets. */
export function slugify(title: string): string {
    const base = title
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/, '');
    return base.length > 0 ? base : 'projet';
}

/** Le premier de `base`, `base-2`, `base-3`… qu'aucun autre projet du domaine ne porte. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) {
        const suffix = `-${n}`;
        const candidate = `${base.slice(0, PROJECT_SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
        if (!taken.has(candidate)) return candidate;
    }
}

async function titleOf(ctx: Ctx, project: ProjectRow): Promise<string> {
    return (await tryDecryptProject(ctx.cipher(), project.content))?.title ?? '';
}

/** Le thème stocké ; une valeur abîmée suit le visiteur. */
export function themeOf(row: ProjectPublicRow): PageThemeChoice {
    return row.theme === 'light' || row.theme === 'dark' ? row.theme : 'auto';
}

/** En ligne, ouvert, et pas tenu en pause par l'offre : ce que la route publique sert. */
function served(ctx: Ctx, row: ProjectPublicRow): boolean {
    return (
        row.enabled === 1 && row.security_tier === 'open' && !ctx.quota.isPaused('pages', publicStockId(row.project_id))
    );
}

async function toPublication(ctx: Ctx, row: ProjectPublicRow): Promise<ProjectPublication> {
    const domain: SdkDomain | null = row.domain_id === null ? null : await ctx.domains.get(row.domain_id);
    let atRoot = false;
    let rootTitle: string | null = null;
    if (domain?.verified) {
        const root = (await ctx.repo.publication.listOnDomain(domain.id)).find(
            (other) => other.workspace_id === domain.workspaceId && served(ctx, other)
        );
        // Hors ligne, le projet rejoindrait la file : il ne tiendrait la racine que seul.
        atRoot = root === undefined || root.project_id === row.project_id;
        if (root && !atRoot) {
            const other = await ctx.repo.projects.findById(root.project_id, domain.workspaceId);
            rootTitle = other ? (await titleOf(ctx, other)) || 'Sans titre' : null;
        }
    }
    const url = !domain?.verified
        ? `${ctx.origins.public}${PUBLIC_PATH}/${row.public_ref}`
        : atRoot
          ? `https://${domain.host}/`
          : `https://${domain.host}${PUBLIC_PATH}/${row.slug ?? row.public_ref}`;
    return {
        enabled: row.enabled === 1,
        domainId: row.domain_id,
        slug: row.slug,
        showDates: row.show_dates === 1,
        showAssignees: row.show_assignees === 1,
        showSubtasks: row.show_subtasks === 1,
        theme: themeOf(row),
        accent: row.accent,
        url,
        atRoot,
        rootTitle,
        planPaused: ctx.quota.isPaused('pages', publicStockId(row.project_id))
    };
}

/**
 * Un domaine de l'espace, vérifié. Celui que le projet a déjà reste accepté s'il
 * retombe en attente : le retirer en silence changerait son adresse.
 */
async function assertDomain(ctx: Ctx, domainId: number, existing: ProjectPublicRow | null): Promise<void> {
    const domain = await ctx.domains.get(domainId);
    if (!domain) throw new FeatureError('not_found', 'Ce domaine n’existe plus dans cet espace.');
    if (!domain.verified && domainId !== existing?.domain_id) {
        throw new FeatureError(
            'validation',
            'Ce domaine n’est pas encore vérifié : finissez sa vérification dans l’onglet Domaines.'
        );
    }
}

/**
 * Le chemin du projet sous son domaine. Choisi, il doit être libre ; sinon celui
 * qu'il a déjà sur ce domaine, ou un nouveau tiré du titre. Renommer le projet ne
 * le change pas : ce serait casser l'adresse donnée.
 */
async function slugFor(
    ctx: Ctx,
    project: ProjectRow,
    draft: ProjectPublicationDraft,
    existing: ProjectPublicRow | null
): Promise<string | null> {
    if (draft.domainId === null) return null;
    const taken = new Set(await ctx.repo.publication.slugsOn(draft.domainId, project.id));
    if (draft.slug !== null) {
        if (taken.has(draft.slug)) {
            throw new FeatureError('conflict', 'Un autre projet porte déjà ce chemin sur ce domaine.');
        }
        return draft.slug;
    }
    if (existing?.domain_id === draft.domainId && existing.slug !== null) return existing.slug;
    return uniqueSlug(slugify(await titleOf(ctx, project)), taken);
}

/**
 * Mis en ligne ou arrivé sur un domaine, un projet en prend la file par la fin,
 * strictement après ceux qui y sont déjà : deux arrivées dans la même seconde ne
 * se départagent pas par leur identifiant.
 */
async function queueEnd(ctx: Ctx, domainId: number, projectId: number, at: number): Promise<number> {
    const others = (await ctx.repo.publication.listOnDomain(domainId)).filter((row) => row.project_id !== projectId);
    return Math.max(at, ...others.map((row) => (row.domain_at ?? 0) + 1));
}

/** Le projet publiable d'ici : chez lui, et ouvert. */
function assertPublishable(ctx: Ctx, project: ProjectRow): void {
    assertAtHome(ctx, project, 'sa page publique');
    if (project.security_tier !== 'open') {
        throw new FeatureError(
            'validation',
            'Un projet confidentiel ne se publie pas : il est chiffré par votre mot de passe, que le serveur n’a pas.'
        );
    }
}

export const projectPublicationFeatures = [
    defineSdkFeature({
        ...projectPublicationGet,
        handler: async (ctx: Ctx, input) => {
            const project = await loadProject(ctx, input.projectId);
            if (isForeign(ctx, project)) return { publication: null, blocked: 'foreign' as const, limit: null };
            if (project.security_tier !== 'open') {
                return { publication: null, blocked: 'guarded' as const, limit: null };
            }
            const [row, limit] = await Promise.all([
                ctx.repo.publication.find(project.id, project.workspace_id),
                ctx.quota.limit('pages')
            ]);
            return { publication: row ? await toPublication(ctx, row) : null, blocked: null, limit };
        }
    }),

    defineSdkFeature({
        ...projectPublish,
        mutates: true,
        access: MANAGE,
        handler: async (ctx: Ctx, input) => {
            const project = await loadProject(ctx, input.projectId, 'write');
            assertPublishable(ctx, project);
            const draft = input.publication;
            const existing = await ctx.repo.publication.find(project.id, project.workspace_id);
            const wasLive = existing?.enabled === 1;
            const goingLive = draft.enabled && !wasLive;
            if (goingLive) {
                await ctx.quota.assert(
                    'pages',
                    async (owned) => (await ctx.repo.publication.countEnabledIn(owned)) + 1
                );
            }
            if (draft.domainId !== null) await assertDomain(ctx, draft.domainId, existing);
            const slug = await slugFor(ctx, project, draft, existing);
            const at = now();
            const joinsDomain = goingLive || draft.domainId !== (existing?.domain_id ?? null);
            await ctx.repo.publication.save(project.id, existing?.public_ref ?? newPublicRef(), {
                enabled: draft.enabled,
                publishedAt: goingLive ? at : (existing?.published_at ?? null),
                domainId: draft.domainId,
                slug,
                domainAt:
                    draft.domainId === null
                        ? null
                        : joinsDomain
                          ? await queueEnd(ctx, draft.domainId, project.id, at)
                          : (existing?.domain_at ?? at),
                showDates: draft.showDates,
                showAssignees: draft.showAssignees,
                showSubtasks: draft.showSubtasks,
                theme: draft.theme,
                accent: draft.accent
            });
            forgetPublicPage(project.id);

            if (goingLive || (wasLive && !draft.enabled)) {
                await recordEvent(ctx, project, {
                    kind: 'projects.publication',
                    label: goingLive ? 'Page publique ouverte' : 'Page publique fermée'
                });
            }
            ctx.audit({
                action: 'projects.publish',
                description: draft.enabled ? 'Page publique d’un projet réglée' : 'Page publique d’un projet fermée',
                metadata: {
                    projectId: project.id,
                    enabled: draft.enabled,
                    domainId: draft.domainId,
                    showDates: draft.showDates,
                    showAssignees: draft.showAssignees,
                    showSubtasks: draft.showSubtasks,
                    theme: draft.theme
                }
            });
            const row = await ctx.repo.publication.find(project.id, project.workspace_id);
            if (!row) throw new FeatureError('not_found', 'Projet introuvable');
            return { publication: await toPublication(ctx, row) };
        }
    }),

    defineSdkFeature({
        ...projectPublicationRelink,
        mutates: true,
        access: MANAGE,
        handler: async (ctx: Ctx, input) => {
            const project = await loadProject(ctx, input.projectId, 'write');
            assertPublishable(ctx, project);
            const existing = await ctx.repo.publication.find(project.id, project.workspace_id);
            if (!existing) throw new FeatureError('not_found', 'Ce projet n’a pas encore de page publique.');
            await ctx.repo.publication.save(project.id, newPublicRef(), {
                enabled: existing.enabled === 1,
                publishedAt: existing.published_at,
                domainId: existing.domain_id,
                slug: existing.slug,
                domainAt: existing.domain_at,
                showDates: existing.show_dates === 1,
                showAssignees: existing.show_assignees === 1,
                showSubtasks: existing.show_subtasks === 1,
                theme: themeOf(existing),
                accent: existing.accent
            });
            forgetPublicPage(project.id);
            await recordEvent(ctx, project, { kind: 'projects.publication', label: 'Lien public changé' });
            ctx.audit({
                action: 'projects.publicationRelink',
                description: 'Lien public d’un projet changé',
                metadata: { projectId: project.id }
            });
            const row = await ctx.repo.publication.find(project.id, project.workspace_id);
            if (!row) throw new FeatureError('not_found', 'Projet introuvable');
            return { publication: await toPublication(ctx, row) };
        }
    })
];
