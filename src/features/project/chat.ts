import {
    PROJECT_MESSAGE_PAGE_SIZE,
    projectMarkRead,
    projectMessageEdit,
    projectMessageList,
    projectMessageSend,
    projectMessageSchema
} from 'deveye-types';
import type { ProjectCardRow, ProjectMessage, ProjectMessageRow, ProjectRow } from 'deveye-types';
import type { Cipher } from '@/Services/SecureStore';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { assertProjectUnlocked, cipherFor, loadProject } from './_shared';

/**
 * Les fils de discussion des cartes.
 *
 * Sujet live **`projectsChat`**, distinct de `projects` : un message ne doit pas
 * faire re-solliciter le tableau, la frise et le portefeuille entiers. C'est la
 * seule raison de cette coupure — les deux sujets pointent la même feature dans
 * `TOPIC_FEATURE`, donc le même droit d'accès.
 *
 * L'indicateur « en train d'écrire » ne passe **pas** par ici : c'est une trame
 * éphémère du moteur live (`live.typing`), sans écriture ni audit.
 */

const READ = { feature: 'projects' } as const;
const WRITE = { feature: 'projects', level: 'write' } as const;

/** Le sujet des messages, déclaré explicitement plutôt que déduit du préfixe. */
const CHAT_TOPIC = ['projectsChat'] as const;

async function loadCard(ctx: FeatureContext, cardId: number): Promise<{ card: ProjectCardRow; project: ProjectRow }> {
    const card = await ctx.db.projectBoard.findCard(cardId, ctx.workspaceId);
    if (!card) throw new FeatureError('not_found', 'Carte introuvable');
    const project = await loadProject(ctx, card.project_id);
    return { card, project };
}

/** Les mentions ne peuvent viser que des membres de l'espace. */
async function cleanMentions(ctx: FeatureContext, mentions: number[]): Promise<number[]> {
    const unique = [...new Set(mentions)];
    const kept: number[] = [];
    for (const userId of unique) {
        if (await ctx.db.workspaceMembers.isMember(userId, ctx.workspaceId)) kept.push(userId);
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
async function toMessage(cipher: Cipher, row: ProjectMessageRow): Promise<ProjectMessage> {
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

export const projectMessageListFeature: FeatureDefinition<
    typeof projectMessageList.command,
    typeof projectMessageList.input,
    typeof projectMessageList.output
> = defineFeature({
    ...projectMessageList,
    access: READ,
    handler: async (ctx, input) => {
        const { project } = await loadCard(ctx, input.cardId);
        await assertProjectUnlocked(ctx, project);

        const limit = input.limit ?? PROJECT_MESSAGE_PAGE_SIZE;
        // Une ligne de plus que demandé : sa présence dit qu'il reste du fil
        // au-dessus, sans second COUNT.
        const rows = await ctx.db.projectChat.listByCard(
            input.cardId,
            ctx.workspaceId,
            input.before ?? null,
            limit + 1
        );
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        const cipher = cipherFor(ctx, project.security_tier);
        // Le repo pagine du plus récent au plus ancien ; l'affichage veut
        // l'inverse.
        const messages = await Promise.all([...page].reverse().map((row) => toMessage(cipher, row)));
        return { messages, hasMore };
    }
});

export const projectMessageSendFeature: FeatureDefinition<
    typeof projectMessageSend.command,
    typeof projectMessageSend.input,
    typeof projectMessageSend.output
> = defineFeature({
    ...projectMessageSend,
    mutates: CHAT_TOPIC,
    access: WRITE,
    handler: async (ctx, input) => {
        const { card, project } = await loadCard(ctx, input.cardId);
        await assertProjectUnlocked(ctx, project);

        const cipher = cipherFor(ctx, project.security_tier);
        const row = await ctx.db.projectChat.create({
            cardId: input.cardId,
            projectId: card.project_id,
            workspaceId: ctx.workspaceId,
            authorUserId: ctx.userId,
            mentions: await cleanMentions(ctx, input.mentions),
            content: await cipher.encrypt(JSON.stringify({ text: input.text }))
        });

        // Son propre message est lu d'office : sans ça, l'auteur verrait un
        // badge de non-lu apparaître sur sa propre carte.
        await ctx.db.projectChat.markRead(input.cardId, ctx.workspaceId, ctx.userId, row.id);

        return { message: await toMessage(cipher, row) };
    }
});

export const projectMessageEditFeature: FeatureDefinition<
    typeof projectMessageEdit.command,
    typeof projectMessageEdit.input,
    typeof projectMessageEdit.output
> = defineFeature({
    ...projectMessageEdit,
    mutates: CHAT_TOPIC,
    access: WRITE,
    handler: async (ctx, input) => {
        const existing = await ctx.db.projectChat.findById(input.messageId, ctx.workspaceId);
        if (!existing) throw new FeatureError('not_found', 'Message introuvable');
        // On ne retouche que ses propres mots — y compris en tant que
        // propriétaire de l'espace : réécrire ceux d'autrui n'est pas un droit.
        if (existing.author_user_id !== ctx.userId) {
            throw new FeatureError('forbidden', 'Vous ne pouvez modifier que vos propres messages.');
        }

        const project = await loadProject(ctx, existing.project_id);
        await assertProjectUnlocked(ctx, project);

        const cipher = cipherFor(ctx, project.security_tier);
        const row = await ctx.db.projectChat.update(input.messageId, ctx.workspaceId, {
            mentions: await cleanMentions(ctx, input.mentions),
            content: await cipher.encrypt(JSON.stringify({ text: input.text }))
        });
        if (!row) throw new FeatureError('not_found', 'Message introuvable');
        return { message: await toMessage(cipher, row) };
    }
});

export const projectMarkReadFeature: FeatureDefinition<
    typeof projectMarkRead.command,
    typeof projectMarkRead.input,
    typeof projectMarkRead.output
> = defineFeature({
    ...projectMarkRead,
    // Pas de `mutates` : une lecture est personnelle. La diffuser ferait
    // re-solliciter tout l'espace parce qu'une seule personne a ouvert une
    // carte. Le client rafraîchit ses propres compteurs localement.
    access: READ,
    handler: async (ctx, input) => {
        await loadCard(ctx, input.cardId);
        await ctx.db.projectChat.markRead(input.cardId, ctx.workspaceId, ctx.userId, input.lastMessageId);
        return { cardId: input.cardId, lastMessageId: input.lastMessageId };
    }
});

export const projectChatFeatures = [
    projectMessageListFeature,
    projectMessageSendFeature,
    projectMessageEditFeature,
    projectMarkReadFeature
];
