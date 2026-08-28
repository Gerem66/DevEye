import {
    projectBoard,
    projectCardAdd,
    projectCardArchive,
    projectCardMove,
    projectCardRestore,
    projectCardUpdate,
    projectColumnAdd,
    projectColumnRemove,
    projectColumnReorder,
    projectColumnUpdate
} from '../contracts/commands';
import { PROJECT_MAX_COLUMNS } from '../contracts/domain';
import type { ProjectCardDraft, ProjectCardRow, ProjectColumnRow, ProjectRow } from '../contracts/domain';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    assertProjectUnlocked,
    cipherFor,
    decryptCard,
    decryptColumn,
    encryptCard,
    encryptColumn,
    isMember,
    loadProject,
    priorityToDb,
    recordEvent,
    toCard,
    toColumn,
    WRITE,
    type Ctx,
    type StoredCard
} from './_shared';

/**
 * Le tableau d'un projet : colonnes et cartes.
 *
 * Toutes les lignes d'un projet sont chiffrées **sous l'étage du projet** : pas
 * de tier par carte. C'est ce qui rend la bascule de confidentialité atomique
 * (voir `reencryptProjectTree`) et évite d'avoir à raisonner carte par carte.
 *
 * ⚠️ Rappel : le contrôle de démarrage de `_topics.ts` ne repère pas les noms en
 * camelCase sous un préfixe unique. Chaque écriture ci-dessous déclare `mutates`
 * à la main, et un oubli ne produirait aucun avertissement.
 */

/** Charge la colonne **et** son projet, en vérifiant qu'ils vont ensemble. */
async function loadColumn(ctx: Ctx, columnId: number): Promise<{ column: ProjectColumnRow; project: ProjectRow }> {
    const column = await ctx.repo.board.findColumn(columnId, ctx.workspaceId);
    if (!column) throw new FeatureError('not_found', 'Colonne introuvable');
    const project = await loadProject(ctx, column.project_id);
    return { column, project };
}

export async function loadCard(ctx: Ctx, cardId: number): Promise<{ card: ProjectCardRow; project: ProjectRow }> {
    const card = await ctx.repo.board.findCard(cardId, ctx.workspaceId);
    if (!card) throw new FeatureError('not_found', 'Carte introuvable');
    const project = await loadProject(ctx, card.project_id);
    return { card, project };
}

/**
 * Un membre à qui attribuer une carte doit appartenir à l'espace.
 *
 * Sans cette garde, un identifiant quelconque passerait (la colonne est en
 * clair et n'a pas de contrainte d'appartenance) et la carte s'afficherait
 * attribuée à un inconnu que l'interface ne saurait pas nommer.
 */
async function assertAssignee(ctx: Ctx, userId: number | null): Promise<void> {
    if (userId === null) return;
    if (!(await isMember(ctx, userId))) {
        throw new FeatureError('validation', 'Cette personne n’est pas membre de cet espace.');
    }
}

function toStoredCard(draft: ProjectCardDraft): StoredCard {
    return { title: draft.title, description: draft.description, checklist: draft.checklist };
}

export const projectBoardFeature = defineSdkFeature({
    ...projectBoard,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        const cipher = cipherFor(ctx, project.security_tier);
        const wantArchived = input.archived === true;

        // Sur un projet gardé, les titres sont sous l'étage gardé : mieux vaut
        // lever `locked` tout de suite (le client ouvre l'invite) que de rendre
        // un tableau entier de cartes sans titre.
        await assertProjectUnlocked(ctx, project);

        const [columnRows, cardRows, unreadRows] = await Promise.all([
            ctx.repo.board.listColumns(input.projectId, ctx.workspaceId),
            ctx.repo.board.listCards(input.projectId, ctx.workspaceId, wantArchived),
            ctx.repo.board.unreadByProject(input.projectId, ctx.workspaceId, ctx.userId)
        ]);

        const unread = new Map(unreadRows.map((u) => [u.card_id, u.unread]));
        const columns = await Promise.all(
            columnRows.map(async (row) => toColumn(row, await decryptColumn(cipher, row.content)))
        );
        const cards = await Promise.all(
            cardRows.map(async (row) => toCard(row, await decryptCard(cipher, row.content), unread.get(row.id) ?? 0))
        );

        // L'archive ne montre pas de colonnes : celles-ci décrivent un flux de
        // travail vivant, et une carte archivée n'y circule plus.
        return { columns: wantArchived ? [] : columns, cards };
    }
});

export const projectColumnAddFeature = defineSdkFeature({
    ...projectColumnAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);

        const existing = await ctx.repo.board.listColumns(input.projectId, ctx.workspaceId);
        if (existing.length >= PROJECT_MAX_COLUMNS) {
            throw new FeatureError('validation', `Un tableau ne peut pas dépasser ${PROJECT_MAX_COLUMNS} colonnes.`);
        }

        const cipher = cipherFor(ctx, project.security_tier);
        const payload = { name: input.name };
        const row = await ctx.repo.board.createColumn({
            projectId: input.projectId,
            workspaceId: ctx.workspaceId,
            content: await encryptColumn(cipher, payload)
        });
        return { column: toColumn(row, payload) };
    }
});

export const projectColumnUpdateFeature = defineSdkFeature({
    ...projectColumnUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const { project } = await loadColumn(ctx, input.columnId);
        await assertProjectUnlocked(ctx, project);

        const cipher = cipherFor(ctx, project.security_tier);
        const payload = { name: input.name };
        const row = await ctx.repo.board.updateColumn(input.columnId, ctx.workspaceId, {
            content: await encryptColumn(cipher, payload),
            countsAsDone: input.countsAsDone,
            wipLimit: input.wipLimit
        });
        if (!row) throw new FeatureError('not_found', 'Colonne introuvable');
        return { column: toColumn(row, payload) };
    }
});

export const projectColumnRemoveFeature = defineSdkFeature({
    ...projectColumnRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const { project } = await loadColumn(ctx, input.columnId);
        await assertProjectUnlocked(ctx, project);

        // La contrainte SQL est en CASCADE : sans cette garde, retirer une
        // colonne détruirait des cartes, alors que rien d'autre dans ce module
        // ne permet d'en supprimer une.
        const held = await ctx.repo.board.countCardsInColumn(input.columnId, ctx.workspaceId);
        if (held > 0) {
            throw new FeatureError(
                'conflict',
                `Cette colonne porte encore ${held} carte(s), archivées comprises. Déplacez-les avant de la retirer.`
            );
        }

        const ok = await ctx.repo.board.deleteColumn(input.columnId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Colonne introuvable');
        return { columnId: input.columnId };
    }
});

export const projectColumnReorderFeature = defineSdkFeature({
    ...projectColumnReorder,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        await loadProject(ctx, input.projectId);
        // Ne touche à aucun corps chiffré : marche session verrouillée.
        await ctx.repo.board.reorderColumns(input.projectId, ctx.workspaceId, input.columnIds);
        return { columnIds: input.columnIds };
    }
});

export const projectCardAddFeature = defineSdkFeature({
    ...projectCardAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const { column, project } = await loadColumn(ctx, input.columnId);
        if (column.project_id !== input.projectId) {
            throw new FeatureError('validation', 'Cette colonne n’appartient pas à ce projet.');
        }
        await assertProjectUnlocked(ctx, project);
        await assertAssignee(ctx, input.card.assigneeUserId);

        const cipher = cipherFor(ctx, project.security_tier);
        const payload = toStoredCard(input.card);
        const row = await ctx.repo.board.createCard({
            projectId: input.projectId,
            workspaceId: ctx.workspaceId,
            columnId: input.columnId,
            authorUserId: ctx.userId,
            assigneeUserId: input.card.assigneeUserId,
            priority: priorityToDb(input.card.priority),
            startDate: input.card.startDate,
            dueDate: input.card.dueDate,
            estimateMinutes: input.card.estimateMinutes,
            content: await encryptCard(cipher, payload)
        });
        return { card: toCard(row, payload, 0) };
    }
});

export const projectCardUpdateFeature = defineSdkFeature({
    ...projectCardUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const { project } = await loadCard(ctx, input.cardId);
        await assertProjectUnlocked(ctx, project);
        await assertAssignee(ctx, input.card.assigneeUserId);

        const cipher = cipherFor(ctx, project.security_tier);
        const payload = toStoredCard(input.card);
        const row = await ctx.repo.board.updateCard(input.cardId, ctx.workspaceId, {
            assigneeUserId: input.card.assigneeUserId,
            priority: priorityToDb(input.card.priority),
            startDate: input.card.startDate,
            dueDate: input.card.dueDate,
            estimateMinutes: input.card.estimateMinutes,
            content: await encryptCard(cipher, payload)
        });
        if (!row) throw new FeatureError('not_found', 'Carte introuvable');
        return { card: toCard(row, payload, 0) };
    }
});

export const projectCardMoveFeature = defineSdkFeature({
    ...projectCardMove,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const { column } = await loadColumn(ctx, input.columnId);

        // Chaque carte listée doit déjà appartenir au même projet que la colonne
        // d'arrivée : sinon un glisser-déposer pourrait transplanter une carte
        // d'un projet à l'autre, ce que l'interface ne propose jamais.
        for (const cardId of input.cardIds) {
            const row = await ctx.repo.board.findCard(cardId, ctx.workspaceId);
            if (!row) throw new FeatureError('not_found', 'Carte introuvable');
            if (row.project_id !== column.project_id) {
                throw new FeatureError('validation', 'Une carte ne change pas de projet.');
            }
        }

        // Aucun corps chiffré n'est touché : un projet confidentiel se réordonne
        // sans déverrouillage.
        await ctx.repo.board.moveCards(ctx.workspaceId, input.columnId, input.cardIds);
        return { columnId: input.columnId, cardIds: input.cardIds };
    }
});

export const projectCardArchiveFeature = defineSdkFeature({
    ...projectCardArchive,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const { card, project } = await loadCard(ctx, input.cardId);
        await assertProjectUnlocked(ctx, project);
        const ok = await ctx.repo.board.archiveCard(input.cardId, ctx.workspaceId, Math.floor(Date.now() / 1000));
        if (!ok) throw new FeatureError('not_found', 'Carte introuvable');

        // Le libellé porte le titre de la carte au moment de l'archivage : la
        // frise doit rester lisible même si la carte est renommée ensuite.
        const title = (await decryptCard(cipherFor(ctx, project.security_tier), card.content)).title;
        await recordEvent(ctx, project, {
            kind: 'card.archived',
            refType: 'card',
            refId: card.id,
            label: title
        });
        ctx.audit({
            action: 'projects.cardArchive',
            description: 'Carte archivée',
            metadata: { cardId: input.cardId, projectId: project.id }
        });
        return { cardId: input.cardId };
    }
});

export const projectCardRestoreFeature = defineSdkFeature({
    ...projectCardRestore,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const { card, project } = await loadCard(ctx, input.cardId);
        await assertProjectUnlocked(ctx, project);
        const ok = await ctx.repo.board.restoreCard(input.cardId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Carte introuvable');
        const title = (await decryptCard(cipherFor(ctx, project.security_tier), card.content)).title;
        await recordEvent(ctx, project, {
            kind: 'card.restored',
            refType: 'card',
            refId: card.id,
            label: title
        });
        return { cardId: input.cardId };
    }
});

export const projectBoardFeatures = [
    projectBoardFeature,
    projectColumnAddFeature,
    projectColumnUpdateFeature,
    projectColumnRemoveFeature,
    projectColumnReorderFeature,
    projectCardAddFeature,
    projectCardUpdateFeature,
    projectCardMoveFeature,
    projectCardArchiveFeature,
    projectCardRestoreFeature
];
