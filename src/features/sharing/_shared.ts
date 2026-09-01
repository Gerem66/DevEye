import type { FeatureId } from '@deveye/types';

import { grantsFor } from '../_access';
import { FeatureError, type FeatureContext } from '../_define';
import { moduleItems } from '../_sdk/register';

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
