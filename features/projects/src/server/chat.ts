import { projectMarkRead, projectMessageEdit, projectMessageList, projectMessageSend } from '../contracts/commands';
import { PROJECT_MESSAGE_PAGE_SIZE, projectMessageSchema } from '../contracts/domain';
import type { ProjectMessage, ProjectMessageRow } from '../contracts/domain';
import { defineSdkFeature, FeatureError, type SdkCipher } from '@deveye/types/sdk/server';

import { loadCard } from './board';
import { assertProjectUnlocked, cipherFor, isMember, loadProject, WRITE, type Ctx } from './_shared';

/**
 * Les fils de discussion des cartes.
 *
 * Sujet live **`projectsChat`**, distinct de `projects` : un message ne doit pas
 * faire re-solliciter le tableau, la frise et le portefeuille entiers. C'est la
 * seule raison de cette coupure. Le sujet est déclaré par le manifest
 * (`topics`, le premier sujet secondaire d'un module) et nommé ici par
 * `mutates: ['projectsChat']` ; il relève de la même feature, donc du même
 * droit d'accès.
 *
 * L'indicateur « en train d'écrire » ne passe **pas** par ici : c'est une trame
 * éphémère du moteur live (`live.typing`), sans écriture ni audit.
 */

/** Le sujet des messages, déclaré explicitement plutôt que déduit du préfixe. */
const CHAT_TOPIC = ['projectsChat'] as const;

/** Les mentions ne peuvent viser que des membres de l'espace. */
async function cleanMentions(ctx: Ctx, mentions: number[]): Promise<number[]> {
    const unique = [...new Set(mentions)];
    const kept: number[] = [];
    for (const userId of unique) {
        if (await isMember(ctx, userId)) kept.push(userId);
    }
    return kept;
}

function parseMentions(raw: string | null): number[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : [];
    } catch {
        return [];
    }
}

/**
 * Déchiffre un message sans jamais lever : un message illisible reste dans le
 * fil, avec un corps vide, plutôt que de faire disparaître la conversation
 * entière. Même parti pris que les autres listes du module.
 */
async function toMessage(cipher: SdkCipher, row: ProjectMessageRow): Promise<ProjectMessage> {
    const plain = await cipher.tryDecrypt(row.content);
    let text = '';
    if (plain !== null) {
        try {
            const parsed = JSON.parse(plain) as { text?: unknown };
            text = typeof parsed.text === 'string' ? parsed.text : '';
        } catch {
            text = '';
        }
    }
    return projectMessageSchema.parse({
        id: row.id,
        cardId: row.card_id,
        authorUserId: row.author_user_id,
        text,
        mentions: parseMentions(row.mentions),
        created: row.created,
        edited: row.edited
    });
}

export const projectMessageListFeature = defineSdkFeature({
    ...projectMessageList,
    handler: async (ctx: Ctx, input) => {
        const { project } = await loadCard(ctx, input.cardId);
        await assertProjectUnlocked(ctx, project);

        const limit = input.limit ?? PROJECT_MESSAGE_PAGE_SIZE;
        // Une ligne de plus que demandé : sa présence dit qu'il reste du fil
        // au-dessus, sans second COUNT.
        const rows = await ctx.repo.chat.listByCard(input.cardId, ctx.workspaceId, input.before ?? null, limit + 1);
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        const cipher = cipherFor(ctx, project.security_tier);
        // Le repo pagine du plus récent au plus ancien ; l'affichage veut
        // l'inverse.
        const messages = await Promise.all([...page].reverse().map((row) => toMessage(cipher, row)));
        return { messages, hasMore };
    }
});

export const projectMessageSendFeature = defineSdkFeature({
    ...projectMessageSend,
    mutates: CHAT_TOPIC,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const { card, project } = await loadCard(ctx, input.cardId);
        await assertProjectUnlocked(ctx, project);

        const cipher = cipherFor(ctx, project.security_tier);
        const row = await ctx.repo.chat.create({
            cardId: input.cardId,
            projectId: card.project_id,
            workspaceId: ctx.workspaceId,
            authorUserId: ctx.userId,
            mentions: await cleanMentions(ctx, input.mentions),
            content: await cipher.encrypt(JSON.stringify({ text: input.text }))
        });

        // Son propre message est lu d'office : sans ça, l'auteur verrait un
        // badge de non-lu apparaître sur sa propre carte.
        await ctx.repo.chat.markRead(input.cardId, ctx.workspaceId, ctx.userId, row.id);

        return { message: await toMessage(cipher, row) };
    }
});

export const projectMessageEditFeature = defineSdkFeature({
    ...projectMessageEdit,
    mutates: CHAT_TOPIC,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const existing = await ctx.repo.chat.findById(input.messageId, ctx.workspaceId);
        if (!existing) throw new FeatureError('not_found', 'Message introuvable');
        // On ne retouche que ses propres mots, y compris en tant que
        // propriétaire de l'espace : réécrire ceux d'autrui n'est pas un droit.
        if (existing.author_user_id !== ctx.userId) {
            throw new FeatureError('forbidden', 'Vous ne pouvez modifier que vos propres messages.');
        }

        const project = await loadProject(ctx, existing.project_id);
        await assertProjectUnlocked(ctx, project);

        const cipher = cipherFor(ctx, project.security_tier);
        const row = await ctx.repo.chat.update(input.messageId, ctx.workspaceId, {
            mentions: await cleanMentions(ctx, input.mentions),
            content: await cipher.encrypt(JSON.stringify({ text: input.text }))
        });
        if (!row) throw new FeatureError('not_found', 'Message introuvable');
        return { message: await toMessage(cipher, row) };
    }
});

export const projectMarkReadFeature = defineSdkFeature({
    ...projectMarkRead,
    // Pas de `mutates` : une lecture est personnelle. La diffuser ferait
    // re-solliciter tout l'espace parce qu'une seule personne a ouvert une
    // carte. Le client rafraîchit ses propres compteurs localement.
    handler: async (ctx: Ctx, input) => {
        await loadCard(ctx, input.cardId);
        await ctx.repo.chat.markRead(input.cardId, ctx.workspaceId, ctx.userId, input.lastMessageId);
        return { cardId: input.cardId, lastMessageId: input.lastMessageId };
    }
});

export const projectChatFeatures = [
    projectMessageListFeature,
    projectMessageSendFeature,
    projectMessageEditFeature,
    projectMarkReadFeature
];
