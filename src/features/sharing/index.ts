import {
    featureDescriptor,
    itemGrantList,
    itemGrantSet,
    shareGet,
    shareSet,
    type FeatureId,
    type ItemGrantState,
    type ItemShareState,
    type ShareBlocker,
    type WorkspaceFeatureGrant
} from '@deveye/types';

import { grantsFor, invalidateAccess } from '../_access';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { moduleItems } from '../_sdk/register';
import { isShareWired, shareBlockerFor } from '../_sharing';

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

/**
 * L'appelant peut-il régler ce que les rôles d'un espace voient ?
 *
 * La même réponse que `workspace.roles` dans cet espace-là — résolue à la
 * demande parce que l'espace visé n'est pas forcément l'actif : c'est ce qui
 * permet de gérer les permissions de toutes les fenêtres depuis l'onglet
 * Partage du domicile. Un espace personnel rend toujours `false` : il n'a pas
 * de rôles, donc rien à régler.
 */
async function canManageRolesIn(ctx: FeatureContext, workspaceId: number): Promise<boolean> {
    const workspace = await ctx.db.workspaces.findById(workspaceId);
    if (!workspace || workspace.kind !== 'shared') return false;
    if (workspace.owner_user_id === ctx.userId) return true;
    const role = await ctx.db.workspaceRoles.findForMember(ctx.userId, workspaceId);
    return grantsFor(false, role).capabilities.has('workspace.roles');
}

/**
 * L'appelant peut-il **écrire** cet élément dans un espace donné — qui n'est
 * pas forcément l'actif ?
 *
 * La question se pose depuis une fenêtre : membre de B qui regarde un élément
 * de A, a-t-il le droit d'en régler le partage ? La réponse est celle qu'il
 * aurait EN A : membre, écriture sur la fonctionnalité, et aucune restriction
 * posée sur cette ligne pour son rôle. C'est la définition de « avoir accès à
 * l'élément racine » — et c'est elle qui décide, pas l'espace où l'on se
 * trouve.
 */
async function canWriteItemIn(
    ctx: FeatureContext,
    workspaceId: number,
    feature: FeatureId,
    itemId: number
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
async function loadHome(ctx: FeatureContext, feature: FeatureId, itemId: number): Promise<number> {
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
 * Un module répond par son entrée `items` (son repo, sa requête) ; les natives
 * par le `switch`, explicite plutôt que dynamique : chaque fonctionnalité range
 * ses éléments dans sa propre table, et une résolution par nom construirait une
 * requête à partir d'une entrée, ce que ce dépôt ne fait nulle part.
 */
async function itemHomeWorkspace(ctx: FeatureContext, feature: FeatureId, itemId: number): Promise<number | null> {
    const items = moduleItems(feature, ctx.db);
    if (items) return items.homeOf(itemId, ctx.workspaceId);
    switch (feature) {
        case 'database':
            return (await ctx.db.databases.find(itemId, ctx.workspaceId))?.workspace_id ?? null;
        case 'deploy':
            return (await ctx.db.deploy.findTarget(itemId, ctx.workspaceId))?.workspace_id ?? null;
        case 'git':
            return (await ctx.db.git.findRepo(itemId, ctx.workspaceId))?.workspace_id ?? null;
        case 'audience':
            return (await ctx.db.audience.find(itemId, ctx.workspaceId))?.workspace_id ?? null;
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
    feature: FeatureId,
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
    // Les projections sont indexées par le DOMICILE — jamais par l'espace
    // actif. Les lire par l'actif rendait l'écran instable : depuis une
    // fenêtre, seule l'origine paraissait cochée, et la fenêtre où l'on se
    // trouvait semblait ne pas exister.
    //
    // Elles se lisent aussi sous le blocage `forbidden` : qui ne peut pas
    // régler le partage voit quand même OÙ l'élément est visible, parmi ses
    // propres espaces (il l'y verrait de toute façon en s'y rendant), et
    // l'écran en lecture seule n'a que ça à dire. Seul `feature` (partage non
    // branché) n'a rien à lire.
    const shares =
        blocker === 'feature'
            ? []
            : await ctx.db.itemSharing.sharesOf(feature, itemId, homeWorkspaceId).catch(() => []);
    const sharedTo = new Set(shares.map((s) => s.workspace_id));

    return {
        workspaces: await Promise.all(
            mine.map(async (w) => {
                // L'origine est toujours « cochée » et jamais décochable :
                // l'élément y est chez lui, pas projeté.
                const shared = w.id === homeWorkspaceId || sharedTo.has(w.id);
                return {
                    workspaceId: w.id,
                    workspaceName: w.name,
                    isHome: w.id === homeWorkspaceId,
                    shared,
                    grantsManageable: shared && !blocker && (await canManageRolesIn(ctx, w.id))
                };
            })
        ),
        blocker
    };
}

const getFeature = defineFeature({
    ...shareGet,
    handler: async (ctx, input) => {
        ctx.assertFeature(input.feature, 'read');
        const blocker = shareBlockerFor(ctx, input.feature);
        if (blocker) {
            // Même bloqué, l'écran doit dire où l'élément est visible : le
            // domicile est résolu pour de vrai, sinon un élément regardé
            // depuis une fenêtre lirait ses projections sous le mauvais index
            // et paraîtrait n'exister qu'ici.
            const share =
                blocker === 'feature'
                    ? null
                    : await ctx.db.itemSharing.findShare(ctx.workspaceId, input.feature, input.itemId);
            return shareState(ctx, input.feature, input.itemId, blocker, share?.home_workspace_id ?? ctx.workspaceId);
        }
        // L'accès à l'élément lui-même, restrictions de rôle comprises : un
        // membre à qui il est masqué n'a pas à savoir où il est projeté.
        await ctx.assertItem(input.feature, input.itemId);
        const share = await ctx.db.itemSharing.findShare(ctx.workspaceId, input.feature, input.itemId);
        if (share && share.home_workspace_id !== ctx.workspaceId) {
            // Depuis une fenêtre, c'est le droit AU DOMICILE qui décide : qui a
            // l'écriture de l'élément chez lui règle son partage d'où il veut —
            // c'est la même personne devant la même donnée. Sans ce droit, on
            // répond quand même, cases inertes : lever afficherait
            // « chargement impossible », qui se lit comme une panne alors que
            // c'est une règle.
            const manageable = await canWriteItemIn(ctx, share.home_workspace_id, input.feature, input.itemId);
            return shareState(ctx, input.feature, input.itemId, manageable ? null : 'foreign', share.home_workspace_id);
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
        // Partager exige l'accès **à l'élément**, pas seulement à la
        // fonctionnalité : sans cette garde, un rôle restreint sur cette ligne
        // (masquée, ou en lecture seule) pouvait la projeter vers son espace
        // personnel et lire par la fenêtre ce que la restriction lui fermait.
        await ctx.assertItem(input.feature, input.itemId, 'write');

        // Le domicile réel : l'espace actif, ou celui d'une projection qu'on
        // regarde. Depuis une fenêtre, c'est le droit AU DOMICILE qui autorise —
        // membre de l'espace d'origine, écriture sur la fonctionnalité là-bas,
        // aucune restriction sur la ligne. La même personne devant la même
        // donnée n'a pas à retraverser pour cocher une case.
        let home = await itemHomeWorkspace(ctx, input.feature, input.itemId);
        if (home === null) {
            const share = await ctx.db.itemSharing.findShare(ctx.workspaceId, input.feature, input.itemId);
            home = share?.home_workspace_id ?? null;
        }
        if (home === null) throw new FeatureError('not_found', 'Élément introuvable');
        if (home !== ctx.workspaceId && !(await canWriteItemIn(ctx, home, input.feature, input.itemId))) {
            throw new FeatureError(
                'forbidden',
                'Cet élément appartient à un autre espace, où vous n’avez pas le droit de le modifier : son partage s’y règle.'
            );
        }

        if (input.workspaceId === home) {
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

/**
 * L'espace **visé** par une lecture ou une écriture de restrictions, vérifié.
 *
 * Trois gardes, dans cet ordre :
 *
 *  1. l'appelant voit l'élément depuis son espace actif (`assertItem`) — un
 *     membre à qui une restriction le masque ne règle pas ce qu'en voient les
 *     autres ;
 *  2. l'espace visé est un des siens — on ne règle pas les rôles d'un espace
 *     où l'on n'entre pas ;
 *  3. l'élément y est réellement visible : son domicile, ou une projection.
 *     Une restriction posée là où l'élément n'apparaît pas serait une ligne
 *     morte qui mordrait le jour d'un futur partage, sans que rien ne le dise.
 */
async function resolveGrantTarget(
    ctx: FeatureContext,
    input: { feature: FeatureId; itemId: number; workspaceId?: number },
    level: 'read' | 'write'
): Promise<{ workspaceId: number; workspaceName: string }> {
    ctx.assertFeature(input.feature, level);
    if (!isShareWired(input.feature)) {
        throw new FeatureError(
            'validation',
            `Les restrictions par élément ne sont pas encore branchées sur ${featureDescriptor(input.feature).label}.`
        );
    }
    await ctx.assertItem(input.feature, input.itemId, level);

    const targetId = input.workspaceId ?? ctx.workspaceId;
    const target = await ctx.db.workspaces.findById(targetId);
    if (!target) throw new FeatureError('not_found', 'Espace introuvable');
    if (target.kind !== 'shared') {
        throw new FeatureError('validation', 'Un espace personnel n’a pas de rôles à restreindre.');
    }
    if (!(await ctx.db.workspaceMembers.isMember(ctx.userId, targetId))) {
        throw new FeatureError('forbidden', 'Vous n’êtes pas membre de cet espace.');
    }

    // L'élément doit exister LÀ-BAS : chez lui, ou par projection.
    const home = await itemHomeWorkspace(ctx, input.feature, input.itemId);
    const share =
        home === null ? await ctx.db.itemSharing.findShare(ctx.workspaceId, input.feature, input.itemId) : null;
    const realHome = home ?? share?.home_workspace_id ?? null;
    if (realHome === null) throw new FeatureError('not_found', 'Élément introuvable');
    if (realHome !== targetId && !(await ctx.db.itemSharing.findShare(targetId, input.feature, input.itemId))) {
        throw new FeatureError('validation', 'Cet élément n’est pas visible dans cet espace.');
    }

    return { workspaceId: targetId, workspaceName: target.name };
}

/**
 * L'état complet des restrictions d'un élément dans un espace : chaque rôle,
 * ce que la fonctionnalité lui donne (l'hérité — affiché même sans exception,
 * pour que la vue d'ensemble n'oblige jamais à deviner), et l'exception posée.
 */
async function grantState(
    ctx: FeatureContext,
    feature: FeatureId,
    itemId: number,
    target: { workspaceId: number; workspaceName: string }
): Promise<ItemGrantState> {
    const [roles, grants] = await Promise.all([
        ctx.db.workspaceRoles.listByWorkspace(target.workspaceId),
        ctx.db.itemSharing.grantsOf(target.workspaceId, feature, itemId)
    ]);
    const byRole = new Map(grants.map((g) => [g.role_id, g.access]));
    return {
        workspaceId: target.workspaceId,
        workspaceName: target.workspaceName,
        roles: roles.map((role) => {
            const featureGrants = parseGrants(role.features);
            return {
                roleId: role.id,
                name: role.name,
                color: role.color,
                featureAccess: featureGrants.find((g) => g.feature === feature)?.access ?? 'none',
                access: byRole.get(role.id) ?? null
            };
        })
    };
}

function parseGrants(raw: unknown): WorkspaceFeatureGrant[] {
    if (Array.isArray(raw)) return raw as WorkspaceFeatureGrant[];
    if (typeof raw === 'string') {
        try {
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) ? (parsed as WorkspaceFeatureGrant[]) : [];
        } catch {
            return [];
        }
    }
    return [];
}

const grantListFeature = defineFeature({
    ...itemGrantList,
    handler: async (ctx, input) => {
        // Lire exige d'être membre de l'espace visé et de voir l'élément ;
        // c'est `resolveGrantTarget` qui le vérifie.
        const target = await resolveGrantTarget(ctx, input, 'read');
        return grantState(ctx, input.feature, input.itemId, target);
    }
});

const grantSetFeature = defineFeature({
    ...itemGrantSet,
    mutates: true,
    handler: async (ctx, input) => {
        const target = await resolveGrantTarget(ctx, input, 'write');
        // Poser une restriction, c'est régler ce qu'un rôle voit : la capacité
        // de l'écran des rôles, **dans l'espace visé** — pas dans l'actif, qui
        // peut être le domicile d'où l'on règle une fenêtre.
        if (!(await canManageRolesIn(ctx, target.workspaceId))) {
            throw new FeatureError('forbidden', 'Vous ne gérez pas les rôles de cet espace.');
        }
        const role = await ctx.db.workspaceRoles.findById(input.roleId, target.workspaceId);
        if (!role) throw new FeatureError('not_found', 'Rôle introuvable');

        await ctx.db.itemSharing.setGrant(target.workspaceId, input.feature, input.itemId, input.roleId, input.access);
        // Les droits de tous ceux qui portent ce rôle viennent de changer, et le
        // scope les mémoïse sous l'époque : sans ce bump, la restriction ne
        // mordrait qu'à la reconnexion suivante.
        invalidateAccess();

        ctx.audit({
            action: 'share.grantSet',
            level: 'warning',
            description: `« ${role.name} » sur ${featureDescriptor(input.feature).label} #${input.itemId} (espace « ${target.workspaceName} ») : ${
                input.access ?? 'comme la fonctionnalité'
            }`
        });
        return grantState(ctx, input.feature, input.itemId, target);
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sharingFeatures: FeatureDefinition<string, any, any>[] = [
    getFeature,
    setFeature,
    grantListFeature,
    grantSetFeature
];
