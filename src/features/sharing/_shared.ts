import type { FeatureId } from '@deveye/types';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider } from '@deveye/types/sdk';

import { grantsFor } from '../_access';
import { FeatureError, type FeatureContext } from '../_define';
import { moduleItems, moduleProvider } from '../_sdk/register';

/**
 * Les gardes que le partage et le déplacement se partagent : « où vit cet
 * élément » et « l'appelant peut-il en disposer là-bas ». Elles répondent pour
 * un espace nommé, et non pour l'espace actif, parce que les deux commandes
 * agissent sur un espace qui n'est pas forcément celui d'où on parle.
 */

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
    const workspace = await ctx.db.workspaces.findById(workspaceId);
    if (!workspace) return false;
    if (workspace.owner_user_id === ctx.userId) return true;
    if (!(await ctx.db.workspaceMembers.isMember(ctx.userId, workspaceId))) return false;
    const role = await ctx.db.workspaceRoles.findForMember(ctx.userId, workspaceId);
    if (grantsFor(false, role).features.get(feature) !== 'write') return false;
    if (!role) return false;
    // La restriction d'élément posée là-bas s'applique là-bas : masqué ou en
    // lecture seule chez lui, on ne gère pas son partage depuis ailleurs.
    const restrictions = await ctx.db.itemSharing.grantsForRole(workspaceId, feature, role.id);
    return !restrictions.some((g) => g.item_id === itemId);
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
