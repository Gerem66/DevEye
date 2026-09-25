import type { FeatureAccess, FeatureId } from '@deveye/types';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider } from '@deveye/types/sdk';

import { grantsFor } from '../_access';
import { FeatureError, type FeatureContext } from '../_define';
import { moduleItems, moduleProvider } from '../_sdk/register';
import { memberPausedIn } from '@/Services/planPauses';

/**
 * Les gardes que le partage et le déplacement se partagent : « où vit cet
 * élément » et « l'appelant peut-il en disposer là-bas ». Elles répondent pour
 * un espace nommé, et non pour l'espace actif, parce que les deux commandes
 * agissent sur un espace qui n'est pas forcément celui d'où on parle.
 */

/**
 * Le droit de l'appelant sur une fonctionnalité dans un espace nommé, et les
 * éléments qu'une restriction lui y ferme. Une seule résolution de rôle pour
 * toute une liste, là où {@link canWriteItemIn} en refait une par élément.
 */
export async function featureAccessIn(
    ctx: FeatureContext,
    workspaceId: number,
    feature: FeatureId
): Promise<{ access: FeatureAccess | null; restricted: ReadonlySet<string> }> {
    const none = { access: null, restricted: new Set<string>() };
    const workspace = await ctx.db.workspaces.findById(workspaceId);
    if (!workspace) return none;
    if (workspace.owner_user_id === ctx.userId) return { access: 'write', restricted: new Set() };
    if (!(await ctx.db.workspaceMembers.isMember(ctx.userId, workspaceId))) return none;
    if (memberPausedIn(workspaceId, ctx.userId)) return none;
    const role = await ctx.db.workspaceRoles.findForMember(ctx.userId, workspaceId);
    const access = grantsFor(false, role).features.get(feature) ?? null;
    if (!role || access === null) return none;
    // La restriction d'élément posée là-bas s'applique là-bas : masqué ou en
    // lecture seule chez lui, on n'en dispose pas depuis ailleurs.
    const rows = await ctx.db.itemSharing.grantsForRole(workspaceId, feature, role.id);
    return { access, restricted: new Set(rows.map((g) => g.item_id)) };
}

/** L'offre du propriétaire tient l'appelant hors de cet espace (jamais le propriétaire lui-même). */
export async function shutOutByPlan(ctx: FeatureContext, workspaceId: number): Promise<boolean> {
    const workspace = await ctx.db.workspaces.findById(workspaceId);
    return workspace !== null && workspace.owner_user_id !== ctx.userId && memberPausedIn(workspaceId, ctx.userId);
}

/**
 * L'appelant peut-il écrire cet élément dans un espace donné, pas forcément
 * l'actif ? La réponse est celle qu'il aurait là-bas : membre, écriture sur la
 * fonctionnalité, et aucune restriction sur cette ligne pour son rôle.
 */
export async function canWriteItemIn(
    ctx: FeatureContext,
    workspaceId: number,
    feature: FeatureId,
    itemId: string
): Promise<boolean> {
    const { access, restricted } = await featureAccessIn(ctx, workspaceId, feature);
    return access === 'write' && !restricted.has(itemId);
}

/** Où vit cet élément, et l'appelant peut-il en disposer ? */
export async function loadHome(ctx: FeatureContext, feature: FeatureId, itemId: string): Promise<number> {
    // L'élément doit être chez l'appelant : depuis une fenêtre on ne le
    // re-projette pas et on ne l'emporte pas, l'espace d'origine perdrait la
    // maîtrise de sa donnée.
    const homeId = await itemHomeWorkspace(ctx, feature, itemId);
    if (homeId === null) throw new FeatureError('not_found', 'Élément introuvable');
    if (homeId !== ctx.workspaceId) {
        throw new FeatureError('forbidden', 'Cet élément appartient à un autre espace : cela se règle depuis là-bas.');
    }
    return homeId;
}

/**
 * L'espace d'origine d'un élément, par l'entrée `items` du module. `null` sans
 * module : l'appelant a déjà été refusé sur le palier, et mieux vaut
 * « introuvable » qu'une projection vers rien.
 */
export async function itemHomeWorkspace(
    ctx: FeatureContext,
    feature: FeatureId,
    itemId: string
): Promise<number | null> {
    const items = moduleItems(feature, ctx.db);
    if (items) return items.homeOf(itemId, ctx.workspaceId);
    return null;
}

/**
 * Où vit l'élément réglé : chez l'appelant, ou le domicile de la projection
 * qu'il regarde. Contrairement à {@link loadHome}, ne refuse pas une fenêtre :
 * une liaison de projet se pose sur un élément projeté.
 */
export async function resolveItemHome(ctx: FeatureContext, feature: FeatureId, itemId: string): Promise<number> {
    const home = await itemHomeWorkspace(ctx, feature, itemId);
    if (home !== null) return home;
    const share = await ctx.db.itemSharing.findShare(ctx.workspaceId, feature, itemId);
    if (share) return share.home_workspace_id;
    throw new FeatureError('not_found', 'Élément introuvable');
}

/** Le contrat qu'offre Projets, seul détenteur des tables de liaison. */
export function usageProvider(): ProjectsUsageProvider | undefined {
    return moduleProvider<ProjectsUsageProvider>(PROJECTS_USAGE_PROVIDER);
}

/**
 * L'élément n'est plus visible de ces espaces (supprimé, déplacé, projection
 * retirée) : les projets qui l'y reliaient le lâchent. Un projet relie ce que
 * son espace voit, chez lui ou projeté, et une liaison vers ce qui n'y est
 * plus resterait une ligne morte, nommant un élément absent.
 */
export async function detachLinks(feature: FeatureId, itemId: string, workspaceIds: Iterable<number>): Promise<void> {
    const numeric = Number(itemId);
    const projects = usageProvider();
    if (!Number.isInteger(numeric) || !projects) return;
    for (const workspaceId of new Set(workspaceIds)) await projects.detach(feature, numeric, workspaceId);
}
