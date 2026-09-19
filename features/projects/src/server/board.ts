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
    decryptCard,
    decryptColumn,
    encryptCard,
    encryptColumn,
    isMember,
    loadProject,
    MANAGE,
    priorityToDb,
    projectCipher,
    recordEvent,
    TASKS,
    toCard,
    toColumn,
    WRITE,
    type Ctx,
    type ItemLevel,
    type StoredCard
} from './_shared';

/**
 * Le tableau d'un projet : colonnes et cartes. Toutes les lignes d'un projet sont
 * chiffrées sous l'étage du projet, jamais un palier par carte, ce qui rend la
 * bascule de confidentialité atomique (`reencryptProjectTree`). Et sous la clé de
 * son espace : un projet projeté ici se lit et s'écrit chez lui, avec les droits
 * d'ici.
 */

/**
 * Charge la colonne et son projet, visible d'ici au niveau demandé. La colonne se lit
 * par son seul identifiant : c'est le projet qui est l'élément gardé, et la colonne
 * porte son espace par construction.
 */
async function loadColumn(
    ctx: Ctx,
    columnId: number,
    level: ItemLevel = 'read'
): Promise<{ column: ProjectColumnRow; project: ProjectRow }> {
    const column = await ctx.repo.board.findColumn(columnId);
    if (!column) throw new FeatureError('not_found', 'Colonne introuvable');
    const project = await loadProject(ctx, column.project_id, level);
    return { column, project };
}

/** Charge la carte et son projet, même règle que la colonne. */
export async function loadCard(
    ctx: Ctx,
    cardId: number,
    level: ItemLevel = 'read'
): Promise<{ card: ProjectCardRow; project: ProjectRow }> {
    const card = await ctx.repo.board.findCard(cardId);
    if (!card) throw new FeatureError('not_found', 'Carte introuvable');
    const project = await loadProject(ctx, card.project_id, level);
    return { card, project };
}

/**
 * Les dates d'une carte relèvent de la planification, que `cardUpdate` ne peut
 * pas exiger d'emblée : elle écrit un brouillon entier, dont les dates ne sont
 * qu'un champ. La garde vit donc ici, où la carte visée est connue, et laisse
 * chacun dater la sienne : celle qu'il porte, ou celle qu'il a écrite et que
 * personne n'a prise. Une carte qu'on crée se date donc librement, et cesse de
 * se replanifier dès qu'elle passe à quelqu'un d'autre.
 */
async function assertDatable(
    ctx: Ctx,
    project: ProjectRow,
    card: { assigneeUserId: number | null; authorUserId: number | null },
    dated: boolean
): Promise<void> {
    if (!dated) return;
    const mine =
        card.assigneeUserId === ctx.userId || (card.assigneeUserId === null && card.authorUserId === ctx.userId);
    if (mine || (await ctx.items.canExtra(String(project.id), 'plan'))) return;
    throw new FeatureError('forbidden', 'La planification ne vous est pas confiée sur ce projet.');
}

/**
 * Un membre à qui attribuer une carte doit appartenir à l'espace actif, même sur un
 * projet projeté : on assigne parmi les gens qu'on voit. Sans cette garde, la colonne
 * étant en clair et sans contrainte d'appartenance, un identifiant quelconque
 * passerait et la carte s'afficherait attribuée à un inconnu.
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
        const cipher = await projectCipher(ctx, project);
        const wantArchived = input.archived === true;

        // Les titres d'un projet gardé sont sous l'étage gardé : mieux vaut lever
        // `locked` que rendre un tableau entier de cartes sans titre.
        await assertProjectUnlocked(ctx, project);

        // Les non-lus sont ceux de l'appelant, chez lui comme par une fenêtre.
        const [columnRows, cardRows, unreadRows] = await Promise.all([
            ctx.repo.board.listColumns(input.projectId, project.workspace_id),
            ctx.repo.board.listCards(input.projectId, project.workspace_id, wantArchived),
            ctx.repo.board.unreadByProject(input.projectId, project.workspace_id, ctx.userId)
        ]);

        const unread = new Map(unreadRows.map((u) => [u.card_id, u.unread]));
        const columns = await Promise.all(
            columnRows.map(async (row) => toColumn(row, await decryptColumn(cipher, row.content)))
        );
        const cards = await Promise.all(
            cardRows.map(async (row) => toCard(row, await decryptCard(cipher, row.content), unread.get(row.id) ?? 0))
        );

        // L'archive ne montre pas de colonnes : elles décrivent un flux de travail
        // vivant, où une carte archivée ne circule plus.
        return { columns: wantArchived ? [] : columns, cards };
    }
});

export const projectColumnAddFeature = defineSdkFeature({
    ...projectColumnAdd,
    mutates: true,
    access: MANAGE,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        await assertProjectUnlocked(ctx, project);

        const existing = await ctx.repo.board.listColumns(input.projectId, project.workspace_id);
        if (existing.length >= PROJECT_MAX_COLUMNS) {
            throw new FeatureError('validation', `Un tableau ne peut pas dépasser ${PROJECT_MAX_COLUMNS} colonnes.`);
        }

        const cipher = await projectCipher(ctx, project);
        const payload = { name: input.name };
        const row = await ctx.repo.board.createColumn({
            projectId: input.projectId,
            workspaceId: project.workspace_id,
            content: await encryptColumn(cipher, payload),
            countsAsDone: input.countsAsDone,
            wipLimit: input.wipLimit
        });
        return { column: toColumn(row, payload) };
    }
});

export const projectColumnUpdateFeature = defineSdkFeature({
    ...projectColumnUpdate,
    mutates: true,
    access: MANAGE,
    handler: async (ctx: Ctx, input) => {
        const { project } = await loadColumn(ctx, input.columnId, 'write');
        await assertProjectUnlocked(ctx, project);

        const cipher = await projectCipher(ctx, project);
        const payload = { name: input.name };
        const row = await ctx.repo.board.updateColumn(input.columnId, project.workspace_id, {
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
    access: MANAGE,
    handler: async (ctx: Ctx, input) => {
        const { project } = await loadColumn(ctx, input.columnId, 'write');
        await assertProjectUnlocked(ctx, project);

        // Sans cette garde, la contrainte SQL détruirait des cartes vivantes, que
        // rien d'autre ici ne permet de supprimer. Les archivées, elles, sont
        // détachées : leur colonne ne veut plus rien dire.
        const held = await ctx.repo.board.countLiveCardsInColumn(input.columnId, project.workspace_id);
        if (held > 0) {
            throw new FeatureError(
                'conflict',
                `Cette colonne porte encore ${held} carte(s). Déplacez-les avant de la retirer.`
            );
        }

        const ok = await ctx.repo.board.deleteColumn(input.columnId, project.workspace_id);
        if (!ok) throw new FeatureError('not_found', 'Colonne introuvable');
        return { columnId: input.columnId };
    }
});

export const projectColumnReorderFeature = defineSdkFeature({
    ...projectColumnReorder,
    mutates: true,
    access: MANAGE,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        // Ne touche à aucun corps chiffré : marche session verrouillée.
        await ctx.repo.board.reorderColumns(input.projectId, project.workspace_id, input.columnIds);
        return { columnIds: input.columnIds };
    }
});

export const projectCardAddFeature = defineSdkFeature({
    ...projectCardAdd,
    mutates: true,
    access: TASKS,
    handler: async (ctx: Ctx, input) => {
        const { column, project } = await loadColumn(ctx, input.columnId, 'write');
        if (column.project_id !== input.projectId) {
            throw new FeatureError('validation', 'Cette colonne n’appartient pas à ce projet.');
        }
        await assertProjectUnlocked(ctx, project);
        await assertAssignee(ctx, input.card.assigneeUserId);

        const cipher = await projectCipher(ctx, project);
        const payload = toStoredCard(input.card);
        const row = await ctx.repo.board.createCard({
            projectId: input.projectId,
            workspaceId: project.workspace_id,
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
        const { card, project } = await loadCard(ctx, input.cardId, 'write');
        await assertProjectUnlocked(ctx, project);
        await assertAssignee(ctx, input.card.assigneeUserId);
        await assertDatable(
            ctx,
            project,
            { assigneeUserId: card.assignee_user_id, authorUserId: card.author_user_id },
            input.card.startDate !== card.start_date || input.card.dueDate !== card.due_date
        );

        const cipher = await projectCipher(ctx, project);
        const payload = toStoredCard(input.card);
        const row = await ctx.repo.board.updateCard(input.cardId, project.workspace_id, {
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
        const { column, project } = await loadColumn(ctx, input.columnId, 'write');

        // Chaque carte listée doit déjà appartenir au projet de la colonne
        // d'arrivée : sinon un glisser-déposer transplanterait une carte d'un projet
        // à l'autre, ce que l'interface ne propose jamais.
        for (const cardId of input.cardIds) {
            const row = await ctx.repo.board.findCard(cardId);
            if (!row) throw new FeatureError('not_found', 'Carte introuvable');
            if (row.project_id !== column.project_id) {
                throw new FeatureError('validation', 'Une carte ne change pas de projet.');
            }
        }

        // Aucun corps chiffré n'est touché : un projet confidentiel se réordonne
        // sans déverrouiller.
        await ctx.repo.board.moveCards(project.workspace_id, input.columnId, input.cardIds);
        return { columnId: input.columnId, cardIds: input.cardIds };
    }
});

export const projectCardArchiveFeature = defineSdkFeature({
    ...projectCardArchive,
    mutates: true,
    access: TASKS,
    handler: async (ctx: Ctx, input) => {
        const { card, project } = await loadCard(ctx, input.cardId, 'write');
        await assertProjectUnlocked(ctx, project);
        const ok = await ctx.repo.board.archiveCard(input.cardId, project.workspace_id, Math.floor(Date.now() / 1000));
        if (!ok) throw new FeatureError('not_found', 'Carte introuvable');

        // Le libellé fige le titre du moment : la frise reste lisible même si la
        // carte est renommée ensuite.
        const title = (await decryptCard(await projectCipher(ctx, project), card.content)).title;
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
    access: TASKS,
    handler: async (ctx: Ctx, input) => {
        const { card, project } = await loadCard(ctx, input.cardId, 'write');
        await assertProjectUnlocked(ctx, project);
        // Sa colonne a pu être retirée pendant qu'elle dormait à l'archive : elle
        // revient alors dans la première du tableau.
        let columnId = card.column_id;
        if (columnId === null) {
            const columns = await ctx.repo.board.listColumns(card.project_id, project.workspace_id);
            if (columns.length === 0) {
                throw new FeatureError('conflict', 'Ce tableau n’a plus de colonne où la remettre.');
            }
            columnId = columns[0].id;
        }

        const ok = await ctx.repo.board.restoreCard(input.cardId, project.workspace_id, columnId);
        if (!ok) throw new FeatureError('not_found', 'Carte introuvable');
        const title = (await decryptCard(await projectCipher(ctx, project), card.content)).title;
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
