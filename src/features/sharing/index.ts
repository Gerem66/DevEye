import {
    SHARE_WIRED_FEATURES,
    featureDescriptor,
    itemGrantList,
    itemGrantSet,
    shareGet,
    shareSet,
    type ItemShareState,
    type ShareBlocker,
    type WorkspaceFeatureId
} from 'deveye-types';

import { invalidateAccess } from '../_access';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { shareBlockerFor } from '../_sharing';

/**
 * Rendre un élément visible depuis un autre espace, et restreindre qui le voit.
 *
 * ## Pourquoi un module transversal
 *
 * Ce que ces commandes prennent est toujours le même couple `(feature, itemId)`.
 * Les recopier par fonctionnalité aurait reproduit exactement ce que
 * l'unification des notifications vient de défaire — cinq jeux identiques dont
 * l'un finit par diverger.
 *
 * ## L'autorisation, et pourquoi elle est en tête de handler
 *
 * La fonctionnalité visée est une **donnée d'entrée**, que le dispatcheur ne
 * connaît pas avant d'appeler le handler. Même situation que `notify.route*` et
 * `device.setConfig`, même remède : la garde est la première ligne, et le
 * fichier figure dans `ACCESS_EXEMPT` avec sa raison.
 */

/** Où vit cet élément, et l'appelant peut-il en disposer ? */
async function loadHome(ctx: FeatureContext, feature: WorkspaceFeatureId, itemId: number): Promise<number> {
    // L'élément doit être **chez l'appelant** pour qu'il en dispose : on ne
    // re-projette pas depuis un espace où l'on ne fait que le voir. Sinon un
    // membre de B pourrait diffuser vers C une donnée de A dont il n'est que
    // spectateur, et l'espace A perdrait la maîtrise de sa donnée sans le savoir.
    const homeId = await itemHomeWorkspace(ctx, feature, itemId);
    if (homeId === null) throw new FeatureError('not_found', 'Élément introuvable');
    if (homeId !== ctx.workspaceId) {
        throw new FeatureError(
            'forbidden',
            'Cet élément appartient à un autre espace : son partage se règle depuis là-bas.'
        );
    }
    return homeId;
}

/**
 * L'espace d'origine d'un élément, lu dans la table de sa fonctionnalité.
 *
 * Le `switch` est explicite plutôt que dynamique : chaque fonctionnalité range
 * ses éléments dans sa propre table, et une résolution par nom construirait une
 * requête à partir d'une entrée — ce que ce dépôt ne fait nulle part.
 */
async function itemHomeWorkspace(
    ctx: FeatureContext,
    feature: WorkspaceFeatureId,
    itemId: number
): Promise<number | null> {
    switch (feature) {
        case 'uptime':
            return (await ctx.db.uptimeServices.findById(itemId, ctx.workspaceId))?.workspace_id ?? null;
        case 'database':
            return (await ctx.db.databases.find(itemId, ctx.workspaceId))?.workspace_id ?? null;
        case 'deploy':
            return (await ctx.db.deploy.findTarget(itemId, ctx.workspaceId))?.workspace_id ?? null;
        case 'backup':
            return (await ctx.db.backup.findJob(itemId, ctx.workspaceId))?.workspace_id ?? null;
        default:
            // Les fonctionnalités qu'on ne sait pas encore projeter tombent ici.
            // `shareBlockerFor` les a déjà refusées sur `shareTier`, donc ce cas
            // ne se produit que si le registre et ce switch divergent — et il
            // vaut mieux « introuvable » qu'une projection vers rien.
            return null;
    }
}

/** L'état complet, relu après chaque écriture plutôt que reconstruit. */
async function shareState(
    ctx: FeatureContext,
    feature: WorkspaceFeatureId,
    itemId: number,
    blocker: ShareBlocker | null,
    /**
     * Le **domicile de l'élément**, et non l'espace actif.
     *
     * Les deux coïncident presque toujours — sauf précisément dans le cas que
     * cet écran doit savoir montrer : un élément qu'on regarde depuis une
     * fenêtre. Les confondre marquait « espace d'origine » sur l'espace où l'on
     * se trouve, c'est-à-dire l'inverse de la vérité.
     */
    homeWorkspaceId: number
): Promise<ItemShareState> {
    // Les espaces de l'appelant, et eux seuls. Partager vers un espace où l'on
    // n'entre pas contournerait l'appartenance, qui est la frontière absolue du
    // modèle — et déposerait une donnée dont on ne pourrait plus répondre.
    const mine = await ctx.db.workspaces.findAccessibleByUser(ctx.userId);
    const shares = blocker ? [] : await ctx.db.itemSharing.sharesOf(feature, itemId, ctx.workspaceId).catch(() => []);
    const sharedTo = new Set(shares.map((s) => s.workspace_id));

    return {
        workspaces: mine.map((w) => ({
            workspaceId: w.id,
            workspaceName: w.name,
            isHome: w.id === homeWorkspaceId,
            // L'origine est toujours « cochée » et jamais décochable : l'élément
            // y est chez lui, pas projeté.
            shared: w.id === homeWorkspaceId || sharedTo.has(w.id)
        })),
        blocker
    };
}

const getFeature = defineFeature({
    ...shareGet,
    handler: async (ctx, input) => {
        ctx.assertFeature(input.feature, 'read');
        const blocker = shareBlockerFor(ctx, input.feature);
        if (blocker) return shareState(ctx, input.feature, input.itemId, blocker, ctx.workspaceId);
        // Un élément qu'on ne fait que voir : on répond, on n'échoue pas. Lever
        // ici afficherait « chargement impossible », qui se lit comme une panne
        // alors que c'est une règle — et une règle qui mérite d'être dite.
        const share = await ctx.db.itemSharing.findShare(ctx.workspaceId, input.feature, input.itemId);
        if (share && share.home_workspace_id !== ctx.workspaceId) {
            return shareState(ctx, input.feature, input.itemId, 'foreign', share.home_workspace_id);
        }
        const home = await loadHome(ctx, input.feature, input.itemId);
        return shareState(ctx, input.feature, input.itemId, null, home);
    }
});

const setFeature = defineFeature({
    ...shareSet,
    mutates: true,
    handler: async (ctx, input) => {
        ctx.assertFeature(input.feature, 'write');
        const blocker = shareBlockerFor(ctx, input.feature);
        if (blocker) throw new FeatureError('validation', 'Cette fonctionnalité ne se partage pas entre espaces.');
        const home = await loadHome(ctx, input.feature, input.itemId);

        if (input.workspaceId === ctx.workspaceId) {
            throw new FeatureError('validation', 'Un élément est toujours visible dans son espace d’origine.');
        }
        // La cible doit être un espace de l'appelant. Vérifié ici et pas
        // seulement à l'écran : c'est la garde qui empêche de projeter chez
        // quelqu'un d'autre.
        if (!(await ctx.db.workspaceMembers.isMember(ctx.userId, input.workspaceId))) {
            throw new FeatureError('forbidden', 'Vous n’êtes pas membre de cet espace.');
        }

        if (input.shared) {
            await ctx.db.itemSharing.share({
                workspace_id: input.workspaceId,
                feature: input.feature,
                item_id: input.itemId,
                home_workspace_id: home,
                shared_by_user_id: ctx.userId
            });
        } else {
            await ctx.db.itemSharing.unshare(input.workspaceId, input.feature, input.itemId);
        }

        ctx.audit({
            action: 'share.set',
            level: 'warning',
            description: `${featureDescriptor(input.feature).label} #${input.itemId} ${
                input.shared ? 'partagé vers' : 'retiré de'
            } l’espace #${input.workspaceId}`
        });
        return shareState(ctx, input.feature, input.itemId, null, home);
    }
});

const grantListFeature = defineFeature({
    ...itemGrantList,
    handler: async (ctx, input) => {
        ctx.assertFeature(input.feature, 'read');
        const rows = await ctx.db.itemSharing.grantsOf(ctx.workspaceId, input.feature, input.itemId);
        return { grants: rows.map((r) => ({ roleId: r.role_id, access: r.access })) };
    }
});

const grantSetFeature = defineFeature({
    ...itemGrantSet,
    mutates: true,
    handler: async (ctx, input) => {
        ctx.assertFeature(input.feature, 'write');
        // Poser une restriction, c'est régler ce qu'un rôle peut voir : la
        // même capacité que l'écran des rôles.
        ctx.assertCan('workspace.roles');
        // Une restriction n'existe que si les listages de la fonctionnalité la
        // FONT RESPECTER (`itemRestrictions` + `assertItem`). Écrire la ligne
        // sans ça serait le pire des mensonges : l'écran dirait « masqué » et le
        // rôle continuerait de tout voir. Même câblage que la projection —
        // les deux s'ouvrent fonctionnalité par fonctionnalité, ensemble.
        if (!SHARE_WIRED_FEATURES.includes(input.feature)) {
            throw new FeatureError(
                'validation',
                `Les restrictions par élément ne sont pas encore branchées sur ${featureDescriptor(input.feature).label}.`
            );
        }
        if (ctx.workspace.kind === 'personal') {
            throw new FeatureError('validation', 'L’espace personnel n’a pas de rôles à restreindre.');
        }
        const role = await ctx.db.workspaceRoles.findById(input.roleId, ctx.workspaceId);
        if (!role) throw new FeatureError('not_found', 'Rôle introuvable');

        await ctx.db.itemSharing.setGrant(ctx.workspaceId, input.feature, input.itemId, input.roleId, input.access);
        // Les droits de tous ceux qui portent ce rôle viennent de changer, et le
        // scope les mémoïse sous l'époque : sans ce bump, la restriction ne
        // mordrait qu'à la reconnexion suivante.
        invalidateAccess();

        ctx.audit({
            action: 'share.grantSet',
            level: 'warning',
            description: `« ${role.name} » sur ${featureDescriptor(input.feature).label} #${input.itemId} : ${
                input.access ?? 'comme la fonctionnalité'
            }`
        });
        const rows = await ctx.db.itemSharing.grantsOf(ctx.workspaceId, input.feature, input.itemId);
        return { grants: rows.map((r) => ({ roleId: r.role_id, access: r.access })) };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sharingFeatures: FeatureDefinition<string, any, any>[] = [
    getFeature,
    setFeature,
    grantListFeature,
    grantSetFeature
];
