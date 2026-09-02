import {
    featureDescriptor,
    itemGrantList,
    itemGrantSet,
    shareGet,
    shareSet,
    type FeatureId,
    type ItemAccess,
    type ItemExtraOverrides,
    type ItemGrantState,
    type ItemShareState,
    type ShareBlocker,
    type WorkspaceFeatureGrant
} from '@deveye/types';

import { grantsFor, invalidateAccess } from '../_access';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { isModuleMovable, moduleItems, moduleManifest } from '../_sdk/register';
import { isShareWired, shareBlockerFor } from '../_sharing';
import { canWriteItemIn, detachLinks, itemHomeWorkspace, loadHome } from './_shared';
import { moveFeatures } from './move';
import { extraOverridesOf } from '@/db/repos/itemSharing';
import { parseJsonArray } from '@/Utils/json';

/**
 * Rendre un élément visible depuis un autre espace, et restreindre qui le voit.
 * Module transversal : le couple `(feature, itemId)` est le même partout.
 * L'autorisation est en tête de handler (et le fichier dans `ACCESS_EXEMPT`) :
 * la fonctionnalité visée est une donnée d'entrée.
 */

/**
 * L'appelant peut-il régler les permissions par élément de CETTE fonctionnalité,
 * dans cet espace ? Deux titres y mènent : gouverner les rôles de l'espace, ou
 * tenir le champ `itemPermissions` du grant de la fonctionnalité — confier le
 * réglage par appareil sans ouvrir l'écran des rôles.
 */
async function canManageItemGrantsIn(ctx: FeatureContext, workspaceId: number, feature: FeatureId): Promise<boolean> {
    const workspace = await ctx.db.workspaces.findById(workspaceId);
    if (!workspace || workspace.kind !== 'shared') return false;
    if (workspace.owner_user_id === ctx.userId) return true;
    const role = await ctx.db.workspaceRoles.findForMember(ctx.userId, workspaceId);
    const grants = grantsFor(false, role);
    return grants.capabilities.has('workspace.roles') || grants.itemPermissions.has(feature);
}

/** L'état complet, relu après chaque écriture plutôt que reconstruit. */
async function shareState(
    ctx: FeatureContext,
    feature: FeatureId,
    itemId: string,
    blocker: ShareBlocker | null,
    /** Le domicile de l'élément, et non l'espace actif (un élément regardé depuis une fenêtre). */
    homeWorkspaceId: number
): Promise<ItemShareState> {
    // Les espaces de l'appelant, et eux seuls : partager vers un espace où l'on
    // n'entre pas contournerait l'appartenance.
    const mine = await ctx.db.workspaces.findAccessibleByUser(ctx.userId);
    // Les projections sont indexées par le domicile, jamais par l'espace actif.
    // Elles se lisent aussi sous le blocage `forbidden` : qui ne peut pas régler
    // le partage voit quand même où l'élément est visible parmi ses propres
    // espaces. Seul `feature` (partage non branché) n'a rien à lire.
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
                    grantsManageable: shared && !blocker && (await canManageItemGrantsIn(ctx, w.id, feature))
                };
            })
        ),
        blocker,
        // Déplacer ne se propose que depuis le domicile, et seulement si la
        // fonctionnalité sait re-chiffrer ses éléments. Les motifs d'un refus
        // sont l'affaire de `share.movePreview`, une fois la cible connue.
        movable: blocker === null && homeWorkspaceId === ctx.workspaceId && isModuleMovable(feature)
    };
}

const getFeature = defineFeature({
    ...shareGet,
    handler: async (ctx, input) => {
        ctx.assertFeature(input.feature, 'read');
        const blocker = shareBlockerFor(ctx, input.feature);
        if (blocker) {
            // Même bloqué, l'écran doit dire où l'élément est visible : le
            // domicile est résolu pour de vrai.
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
            // Depuis une fenêtre, c'est le droit au domicile qui décide. Sans ce
            // droit, on répond quand même, cases inertes : lever se lirait comme
            // une panne alors que c'est une règle.
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
        // Partager exige l'accès à l'élément, pas seulement à la fonctionnalité :
        // sinon un rôle restreint sur cette ligne pourrait la projeter vers son
        // espace personnel et lire par la fenêtre ce que la restriction lui ferme.
        await ctx.assertItem(input.feature, input.itemId, 'write');

        // Le domicile réel : l'espace actif, ou celui d'une projection qu'on
        // regarde. Depuis une fenêtre, c'est le droit au domicile qui autorise.
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
            // Le palier de l'élément, demandé à sa feature : un élément chiffré
            // par le mot de passe de son auteur ne se lit dans aucun autre
            // espace, et le refuser ici vaut mieux qu'une fenêtre vide là-bas.
            const items = moduleItems(input.feature, ctx.db);
            if (items && !(await items.shareable(input.itemId, home))) {
                throw new FeatureError(
                    'validation',
                    'Cet élément est chiffré par votre mot de passe : il ne se lit que dans son espace et ne peut pas être projeté.'
                );
            }
            await ctx.db.itemSharing.share({
                workspace_id: input.workspaceId,
                feature: input.feature,
                item_id: input.itemId,
                home_workspace_id: home,
                shared_by_user_id: ctx.userId
            });
        } else {
            await ctx.db.itemSharing.unshare(input.workspaceId, input.feature, input.itemId);
            // Les projets de là-bas qui le reliaient ne le voient plus.
            await detachLinks(input.feature, input.itemId, [input.workspaceId]);
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
 * L'espace visé par une lecture ou une écriture de restrictions, vérifié :
 * l'appelant voit l'élément depuis son espace actif, l'espace visé est un des
 * siens, et l'élément y est réellement visible (domicile ou projection), sinon
 * la restriction serait une ligne morte qui mordrait à un futur partage.
 */
async function resolveGrantTarget(
    ctx: FeatureContext,
    input: { feature: FeatureId; itemId: string; workspaceId?: number },
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
 * ce que la fonctionnalité lui donne, et l'exception posée.
 */
/** Ce que le journal retient d'une surcharge posée : les deux volets, ou celui touché. */
function grantAudit(input: { access?: ItemAccess | null; extraOverrides?: ItemExtraOverrides }): string {
    const parts: string[] = [];
    if (input.access !== undefined) parts.push(input.access ?? 'comme la fonctionnalité');
    if (input.extraOverrides !== undefined) {
        const entries = Object.entries(input.extraOverrides);
        parts.push(
            entries.length === 0
                ? 'aucune permission surchargée'
                : entries.map(([key, on]) => `${on ? '+' : '-'}${key}`).join(' ')
        );
    }
    return parts.join(' ; ');
}

async function grantState(
    ctx: FeatureContext,
    feature: FeatureId,
    itemId: string,
    target: { workspaceId: number; workspaceName: string }
): Promise<ItemGrantState> {
    const [roles, grants] = await Promise.all([
        ctx.db.workspaceRoles.listByWorkspace(target.workspaceId),
        ctx.db.itemSharing.grantsOf(target.workspaceId, feature, itemId)
    ]);
    const byRole = new Map(grants.map((g) => [g.role_id, g]));
    // Les booléens seulement : un choix borné n'a pas de « moins que » que le
    // socle sache poser, il reste réglé à l'échelle de la fonctionnalité.
    const specs = (moduleManifest(feature)?.extraPermissions ?? []).filter((spec) => spec.type === 'toggle');
    return {
        workspaceId: target.workspaceId,
        workspaceName: target.workspaceName,
        extras: specs.map((spec) => ({ key: spec.key, label: spec.label })),
        roles: roles.map((role) => {
            const featureGrants = parseJsonArray<WorkspaceFeatureGrant>(role.features);
            const grant = featureGrants.find((g) => g.feature === feature);
            const row = byRole.get(role.id) ?? null;
            const held = specs.filter((spec) => grant?.extras?.[spec.key] === true).map((spec) => spec.key);
            return {
                roleId: role.id,
                name: role.name,
                color: role.color,
                featureAccess: grant?.access ?? 'none',
                access: row?.access ?? null,
                featureExtras: held,
                // Une clé que le manifest ne déclare plus n'a rien à faire ici :
                // la ligne peut en garder une d'une permission retirée depuis, et
                // l'écran laisserait croire à une surcharge vivante.
                extraOverrides: Object.fromEntries(
                    Object.entries(extraOverridesOf(row ?? { extra_overrides: null })).filter(([key]) =>
                        specs.some((spec) => spec.key === key)
                    )
                )
            };
        })
    };
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
        // Poser une surcharge, c'est régler ce qu'un rôle fait de cet élément :
        // dans l'espace visé et non dans l'actif.
        if (!(await canManageItemGrantsIn(ctx, target.workspaceId, input.feature))) {
            throw new FeatureError('forbidden', 'Vous ne réglez pas les permissions de cette fonctionnalité.');
        }
        const role = await ctx.db.workspaceRoles.findById(input.roleId, target.workspaceId);
        if (!role) throw new FeatureError('not_found', 'Rôle introuvable');

        // Une clé que le manifest ne déclare pas ne doit pas se ranger en base :
        // inerte aujourd'hui, elle ressusciterait le jour où une permission
        // reprendrait son nom. Les booléens seulement, comme à la lecture.
        const toggles = new Set(
            (moduleManifest(input.feature)?.extraPermissions ?? [])
                .filter((spec) => spec.type === 'toggle')
                .map((spec) => spec.key)
        );
        for (const key of Object.keys(input.extraOverrides ?? {})) {
            if (!toggles.has(key)) {
                throw new FeatureError('validation', `Permission inconnue « ${key} » pour « ${input.feature} »`);
            }
        }

        await ctx.db.itemSharing.setGrant(target.workspaceId, input.feature, input.itemId, input.roleId, {
            access: input.access,
            extraOverrides: input.extraOverrides
        });
        // Les droits de tous ceux qui portent ce rôle viennent de changer, et le
        // scope les mémoïse sous l'époque : sans ce bump, la surcharge ne
        // mordrait qu'à la reconnexion suivante.
        invalidateAccess();
        // Et le `resync` juste derrière, comme partout où l'époque bouge : les
        // instantanés de droits que le hub garde par socket sont désormais
        // périmés, et une époque périmée vaut AUCUN droit. Sans lui, la trame
        // qui dit « les appareils ont changé » serait abandonnée pour tout le
        // monde, et le réglage n'aurait l'air de prendre qu'au rechargement.
        await ctx.live?.resync(ctx.db, target.workspaceId);
        // L'époque est globale : la salle depuis laquelle on règle est périmée
        // elle aussi, même quand la surcharge vise un autre espace.
        if (target.workspaceId !== ctx.workspaceId) await ctx.live?.resync(ctx.db, ctx.workspaceId);

        ctx.audit({
            action: 'share.grantSet',
            level: 'warning',
            description:
                `« ${role.name} » sur ${featureDescriptor(input.feature).label} #${input.itemId} ` +
                `(espace « ${target.workspaceName} ») : ${grantAudit(input)}`
        });
        return grantState(ctx, input.feature, input.itemId, target);
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sharingFeatures: FeatureDefinition<string, any, any>[] = [
    getFeature,
    setFeature,
    grantListFeature,
    grantSetFeature,
    ...moveFeatures
];
