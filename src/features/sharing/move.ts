import {
    featureDescriptor,
    itemMove,
    itemMovePreview,
    type FeatureId,
    type ItemMoveDependency,
    type ItemMovePreview,
    type NotificationFeature
} from '@deveye/types';

import type { Database } from '@/db';
import { createOpenCipher } from '@/Services/SecureStore';

import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { moduleItems } from '../_sdk/register';
import { canWriteItemIn, detachLinks, loadHome, usageProvider } from './_shared';

/**
 * Changer un élément d'espace. La seule opération du système qui re-chiffre :
 * lue sous la clé de son espace, réécrite sous celle de la cible. Tout le reste
 * garde un blob sous la clé qui l'a scellé (levier L3 de `WORKSPACES.md`), et
 * partager ne fait que projeter (`SHARING.md`).
 *
 * Deux moitiés, et la frontière compte : la fonctionnalité convertit son arbre
 * (elle seule sait quelles cellules sont chiffrées), l'app fait le ménage de ce
 * qui désigne l'espace quitté. Les deux dans une transaction, sans quoi un
 * élément à moitié converti serait illisible pour toujours.
 *
 * Aucun droit nouveau : qui peut supprimer l'élément peut le déplacer. Dans les
 * deux cas la donnée quitte l'espace, et supprimer n'a jamais demandé plus que
 * l'écriture.
 */

/** Ce qu'un déplacement suppose, résolu une fois pour les deux commandes. */
interface MoveContext {
    preview: ItemMovePreview;
    homeWorkspaceId: number;
    targetWorkspaceId: number;
}

/**
 * Les liaisons qui visent cet élément, chez lui et dans chaque espace qui le
 * recevait : elles appartiennent à Projets, et une liaison ne suit pas un
 * élément qui quitte l'espace du projet. Toutes tombent donc, et l'écran les
 * nomme avant de confirmer.
 */
async function dependenciesOf(
    db: Database,
    feature: FeatureId,
    itemId: string,
    homeWorkspaceId: number,
    homeName: string,
    targetWorkspaceId: number
): Promise<ItemMoveDependency[]> {
    const numeric = Number(itemId);
    if (!Number.isInteger(numeric)) return [];
    const projects = usageProvider();
    if (!projects) return [];
    // La cible est exclue : l'élément y arrive chez lui, ses projets d'ici le
    // gardent.
    const shares = (await db.itemSharing.sharesOf(feature, itemId, homeWorkspaceId)).filter(
        (s) => s.workspace_id !== targetWorkspaceId
    );
    const places = [
        { workspaceId: homeWorkspaceId, name: homeName },
        ...(await Promise.all(
            shares.map(async (s) => ({
                workspaceId: s.workspace_id,
                name: (await db.workspaces.findById(s.workspace_id))?.name ?? `espace #${s.workspace_id}`
            }))
        ))
    ];
    const deps: ItemMoveDependency[] = [];
    for (const place of places) {
        for (const u of await projects.usageOf(feature, numeric, place.workspaceId)) {
            deps.push({
                feature: 'projects' as FeatureId,
                itemId: String(u.projectId),
                label: u.title,
                reason: `Ce projet reste dans « ${place.name} ».`
            });
        }
    }
    return deps;
}

/** Ce que le déplacement détruira, nommé pour que le popup le dise. */
async function dropsOf(db: Database, feature: FeatureId, itemId: string, homeWorkspaceId: number): Promise<string[]> {
    const drops: string[] = [];
    const shares = await db.itemSharing.sharesOf(feature, itemId, homeWorkspaceId);
    if (shares.length > 0) {
        drops.push(
            shares.length === 1
                ? 'Sa visibilité dans un autre espace'
                : `Sa visibilité dans ${shares.length} autres espaces`
        );
    }
    // Les surcharges n'existent que là où l'élément se voit : son domicile et
    // les espaces qui le reçoivent.
    const scopes = [homeWorkspaceId, ...shares.map((s) => s.workspace_id)];
    const grants = await Promise.all(scopes.map((ws) => db.itemSharing.grantsOf(ws, feature, itemId)));
    if (grants.some((rows) => rows.length > 0)) drops.push('Les permissions réglées sur lui, rôle par rôle');

    const routeItemId = Number(itemId);
    if (Number.isInteger(routeItemId)) {
        const route = await db.notificationChannels.findRoute(
            homeWorkspaceId,
            feature as NotificationFeature,
            routeItemId
        );
        if (route) drops.push('Son acheminement d’alertes, les canaux étant ceux de cet espace');
    }
    return drops;
}

/**
 * Le plan complet, sans rien écrire. Les gardes lèvent (l'écran ne propose pas
 * un déplacement qu'elles refuseraient) ; ce qui tient à la cible se range dans
 * `blockers`, où il s'affiche au lieu de passer pour une panne.
 */
async function buildContext(
    ctx: FeatureContext,
    feature: FeatureId,
    itemId: string,
    targetId: number
): Promise<MoveContext> {
    ctx.assertFeature(feature, 'write');
    await ctx.assertItem(feature, itemId, 'write');
    const homeWorkspaceId = await loadHome(ctx, feature, itemId);
    if (targetId === homeWorkspaceId) {
        throw new FeatureError('validation', 'Cet élément est déjà dans cet espace.');
    }
    const target = await ctx.db.workspaces.findById(targetId);
    if (!target) throw new FeatureError('not_found', 'Espace introuvable');
    if (!(await ctx.db.workspaceMembers.isMember(ctx.userId, targetId))) {
        throw new FeatureError('forbidden', 'Vous n’êtes pas membre de cet espace.');
    }

    const label = featureDescriptor(feature).label;
    const items = moduleItems(feature, ctx.db);
    const move = items?.move;
    const blockers: string[] = [];
    let rows = 0;
    let drops: string[] = [];

    if (!items || !move) {
        blockers.push(`${label} ne sait pas encore déplacer ses éléments d’un espace à l’autre.`);
    } else if (!(await items.shareable(itemId, homeWorkspaceId))) {
        // Chiffré par le mot de passe de son auteur : la clé de la cible ne le
        // rouvrirait pas, et le re-chiffrer exigerait une session déverrouillée.
        blockers.push('Cet élément est chiffré par votre mot de passe : il ne vit que dans son espace.');
    } else if (!(await canWriteItemIn(ctx, targetId, feature, itemId))) {
        blockers.push(`Vous n’avez pas le droit d’écrire ${label} dans « ${target.name} ».`);
    } else {
        const plan = await move.plan(itemId, homeWorkspaceId, targetId);
        blockers.push(...plan.blockers);
        rows = plan.rows;
        drops = [...plan.drops];
    }

    if (blockers.length === 0) drops = [...drops, ...(await dropsOf(ctx.db, feature, itemId, homeWorkspaceId))];

    return {
        homeWorkspaceId,
        targetWorkspaceId: targetId,
        preview: {
            workspaceId: targetId,
            workspaceName: target.name,
            homeWorkspaceName: ctx.workspace.name,
            // Les autres membres perdent l'accès sans qu'on les prévienne : la
            // phrase est tout ce qui le dit.
            losesSharedAccess: ctx.workspace.kind === 'shared',
            blockers,
            drops,
            rows,
            dependencies:
                blockers.length === 0
                    ? await dependenciesOf(ctx.db, feature, itemId, homeWorkspaceId, ctx.workspace.name, targetId)
                    : []
        }
    };
}

const movePreviewFeature = defineFeature({
    ...itemMovePreview,
    handler: async (ctx, input) => (await buildContext(ctx, input.feature, input.itemId, input.workspaceId)).preview
});

const moveFeature = defineFeature({
    ...itemMove,
    mutates: true,
    handler: async (ctx, input) => {
        // Le plan est refait ici : celui du popup a pu vieillir, et c'est lui
        // qui porte les refus.
        const { preview, homeWorkspaceId, targetWorkspaceId } = await buildContext(
            ctx,
            input.feature,
            input.itemId,
            input.workspaceId
        );
        if (preview.blockers.length > 0) throw new FeatureError('validation', preview.blockers[0]);

        const items = moduleItems(input.feature, ctx.db);
        const move = items?.move;
        if (!move) throw new FeatureError('validation', 'Cette fonctionnalité ne déplace pas ses éléments.');

        const ciphers = {
            from: createOpenCipher(ctx.db, ctx.crypt, homeWorkspaceId),
            to: createOpenCipher(ctx.db, ctx.crypt, targetWorkspaceId)
        };

        // Relevées AVANT le ménage : les projections disent où l'élément était
        // visible, donc quels projets le reliaient.
        const shares = await ctx.db.itemSharing.sharesOf(input.feature, input.itemId, homeWorkspaceId);

        await ctx.db.transaction(async (db) => {
            await move.apply(db.queryable, input.itemId, homeWorkspaceId, targetWorkspaceId, ciphers);
            // Le ménage de ce qui nomme l'espace quitté, le pendant de
            // `ctx.items.forget` : l'élément arrive nu. Les projections avaient
            // été accordées par des membres de l'espace d'origine, sur une
            // donnée qui n'y est plus.
            await db.itemSharing.forgetItem(input.feature, input.itemId, homeWorkspaceId);
            const routeItemId = Number(input.itemId);
            if (Number.isInteger(routeItemId)) {
                await db.notificationChannels.clearRoute(
                    homeWorkspaceId,
                    input.feature as NotificationFeature,
                    routeItemId
                );
            }
        });

        // Après le commit : les liaisons appartiennent à Projets, qui écrit sur
        // le pool. Chez lui et dans chaque espace qui le recevait, sauf la
        // cible, où l'élément arrive chez lui : ailleurs il n'est plus visible.
        // Un échec ici laisse une liaison vers un élément parti, que l'écran de
        // Projets montre déjà comme « Élément disparu ».
        const leaving = [homeWorkspaceId, ...shares.map((s) => s.workspace_id)].filter(
            (ws) => ws !== targetWorkspaceId
        );
        await detachLinks(input.feature, input.itemId, leaving).catch((err: unknown) => {
            ctx.logger.warn(
                { err, feature: input.feature, itemId: input.itemId },
                'move: liaisons de Projets non retirées'
            );
        });

        ctx.audit({
            action: 'share.move',
            level: 'warning',
            description:
                `${featureDescriptor(input.feature).label} #${input.itemId} déplacé de ` +
                `« ${preview.homeWorkspaceName} » vers « ${preview.workspaceName} »`
        });
        return { workspaceId: targetWorkspaceId };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const moveFeatures: FeatureDefinition<string, any, any>[] = [movePreviewFeature, moveFeature];
