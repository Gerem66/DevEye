import type {
    Project,
    ProjectCard,
    ProjectCardRow,
    ProjectChecklistItem,
    ProjectColumn,
    ProjectColumnRow,
    ProjectPriority,
    ProjectRow,
    ProjectSummary,
    ProjectTag
} from 'deveye-types';
import { PROJECT_PRIORITIES, projectCardSchema, projectColumnSchema, projectSchema } from 'deveye-types';
import type { Cipher } from '@/Services/SecureStore';
import { FeatureError, type FeatureContext } from '../_define';
import type { ProjectStats } from '@/db/repos/projects';

/**
 * Payload chiffré d'un projet (`projects.content`). N'y vit que ce qui
 * identifie ; `status`, `security_tier`, `sort_order` et les dates restent en
 * colonnes claires pour que le portefeuille se liste et se trie sans clé.
 */
export interface StoredProject {
    title: string;
    description: string;
    tags: ProjectTag[];
    version: string;
}

/**
 * L'étage sous lequel vit l'arbre d'un projet. Choisir le chiffre **est** le
 * contrôle d'accès : un projet gardé ne se lit ni ne s'écrit tant que la session
 * n'est pas déverrouillée, sans qu'aucune garde n'ait à le dire.
 */
export function cipherFor(ctx: FeatureContext, tier: ProjectRow['security_tier']): Cipher {
    return tier === 'guarded' ? ctx.secure : ctx.secure.open;
}

export async function encryptProject(cipher: Cipher, payload: StoredProject): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

function parseProject(plain: string): StoredProject | null {
    try {
        const parsed = JSON.parse(plain) as Partial<StoredProject>;
        return {
            title: typeof parsed.title === 'string' ? parsed.title : '',
            description: typeof parsed.description === 'string' ? parsed.description : '',
            tags: Array.isArray(parsed.tags) ? (parsed.tags as ProjectTag[]) : [],
            version: typeof parsed.version === 'string' ? parsed.version : ''
        };
    } catch {
        return null;
    }
}

/** Propage l'erreur du chiffre, `locked` compris — c'est l'invite du client. */
export async function decryptProject(cipher: Cipher, content: string): Promise<StoredProject | null> {
    return parseProject(await cipher.decrypt(content));
}

/** Variante non levante, pour les listes où une ligne fautive ne doit pas tout casser. */
export async function tryDecryptProject(cipher: Cipher, content: string): Promise<StoredProject | null> {
    const plain = await cipher.tryDecrypt(content);
    return plain === null ? null : parseProject(plain);
}

export function toProject(row: ProjectRow, payload: StoredProject): Project {
    return projectSchema.parse({
        id: row.id,
        title: payload.title,
        description: payload.description,
        tags: payload.tags,
        version: payload.version,
        versionSource: row.version_source,
        status: row.status,
        securityTier: row.security_tier,
        startDate: row.start_date,
        dueDate: row.due_date,
        sortOrder: row.sort_order,
        authorUserId: row.user_id,
        archived: row.archived_at !== null,
        created: row.created,
        updated: row.updated
    });
}

/**
 * La ligne de portefeuille d'un projet illisible : ses compteurs, et un corps
 * vide marqué `masked`. La liste doit dire qu'un projet existe même verrouillée
 * — le faire disparaître laisserait croire à une perte. Même parti pris que les
 * notes privées.
 */
export function toMaskedSummary(row: ProjectRow, stats: ProjectStats | undefined): ProjectSummary {
    return withStats(toProject(row, { title: '', description: '', tags: [], version: '' }), true, stats);
}

export function toSummary(row: ProjectRow, payload: StoredProject, stats: ProjectStats | undefined): ProjectSummary {
    return withStats(toProject(row, payload), false, stats);
}

function withStats(project: Project, masked: boolean, stats: ProjectStats | undefined): ProjectSummary {
    return {
        project,
        masked,
        cardTotal: stats?.card_total ?? 0,
        cardDone: stats?.card_done ?? 0,
        cardOverdue: stats?.card_overdue ?? 0,
        nextDueDate: stats?.next_due_date ?? null,
        unread: stats?.unread ?? 0
    };
}

/** Charge un projet de l'espace actif, ou lève `not_found`. */
export async function loadProject(ctx: FeatureContext, projectId: number): Promise<ProjectRow> {
    const row = await ctx.db.projects.findById(projectId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Projet introuvable');
    return row;
}

/**
 * Le tier `guarded` n'a de sens que dans un espace personnel.
 *
 * Ce qui protège un projet confidentiel n'est pas un contrôle d'accès mais le
 * chiffrement : son arbre passe par l'étage gardé, c'est-à-dire la DEK emballée
 * par le mot de passe. Dans un espace partagé, cette clé est celle du
 * **propriétaire** — le projet deviendrait illisible pour les autres membres, ou
 * (si l'espace a sa propre clé) lisible par tous tout en s'annonçant
 * confidentiel. Les deux issues sont pires que le refus.
 *
 * Un espace partagé n'est pas pour autant en clair : son arbre est chiffré sous
 * la clé de l'espace, à l'étage ouvert.
 */
export function assertGuardedAllowed(ctx: FeatureContext, tier: ProjectRow['security_tier']): void {
    if (tier !== 'guarded' || ctx.workspace.kind === 'personal') return;
    throw new FeatureError(
        'validation',
        'Un projet confidentiel n’existe que dans votre espace personnel : dans un espace partagé, ' +
            'il serait chiffré avec la clé de son propriétaire.'
    );
}

/**
 * Garde les chemins qui écrivent ou détruisent un projet gardé. Le chiffrement
 * protège les lectures, mais une archive ou un renommage n'a jamais besoin de
 * *lire* le corps : sans ça, une session verrouillée pourrait écraser un projet
 * qu'elle ne peut pas voir. Lève `locked`, que le client transforme en invite.
 */
export async function assertProjectUnlocked(ctx: FeatureContext, row: ProjectRow): Promise<void> {
    if (row.security_tier !== 'guarded') return;
    if (!(await ctx.secure.isUnlocked())) {
        throw new FeatureError(
            'locked',
            'Le chiffrement par mot de passe est verrouillé ; saisissez-le pour continuer'
        );
    }
}

// ------------------------------------------------------------------ tableau

/** Payload chiffré d'une colonne (`project_columns.content`). */
export interface StoredColumn {
    name: string;
}

/** Payload chiffré d'une carte (`project_cards.content`). */
export interface StoredCard {
    title: string;
    description: string;
    checklist: ProjectChecklistItem[];
}

export async function encryptColumn(cipher: Cipher, payload: StoredColumn): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

export async function encryptCard(cipher: Cipher, payload: StoredCard): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

function parseColumn(plain: string): StoredColumn {
    try {
        const parsed = JSON.parse(plain) as Partial<StoredColumn>;
        return { name: typeof parsed.name === 'string' ? parsed.name : '' };
    } catch {
        return { name: '' };
    }
}

function parseCard(plain: string): StoredCard {
    try {
        const parsed = JSON.parse(plain) as Partial<StoredCard>;
        return {
            title: typeof parsed.title === 'string' ? parsed.title : '',
            description: typeof parsed.description === 'string' ? parsed.description : '',
            checklist: Array.isArray(parsed.checklist) ? (parsed.checklist as ProjectChecklistItem[]) : []
        };
    } catch {
        return { title: '', description: '', checklist: [] };
    }
}

/**
 * Déchiffre une colonne sans jamais lever : une colonne dont le nom résiste doit
 * rester affichable (et ses cartes déplaçables) plutôt que de faire disparaître
 * le tableau entier. Même parti pris que `decryptService` côté Uptime.
 */
export async function decryptColumn(cipher: Cipher, content: string): Promise<StoredColumn> {
    const plain = await cipher.tryDecrypt(content);
    return plain === null ? { name: '' } : parseColumn(plain);
}

export async function decryptCard(cipher: Cipher, content: string): Promise<StoredCard> {
    const plain = await cipher.tryDecrypt(content);
    return plain === null ? { title: '', description: '', checklist: [] } : parseCard(plain);
}

export function toColumn(row: ProjectColumnRow, payload: StoredColumn): ProjectColumn {
    return projectColumnSchema.parse({
        id: row.id,
        projectId: row.project_id,
        name: payload.name,
        sortOrder: row.sort_order,
        countsAsDone: row.counts_as_done === 1,
        wipLimit: row.wip_limit
    });
}

/** L'indice dans `PROJECT_PRIORITIES` **est** la valeur stockée (TINYINT). */
export function priorityFromDb(value: number): ProjectPriority {
    return PROJECT_PRIORITIES[value] ?? 'none';
}

export function priorityToDb(priority: ProjectPriority): number {
    const index = PROJECT_PRIORITIES.indexOf(priority);
    return index < 0 ? 0 : index;
}

export function toCard(row: ProjectCardRow, payload: StoredCard, unread: number): ProjectCard {
    return projectCardSchema.parse({
        id: row.id,
        projectId: row.project_id,
        columnId: row.column_id,
        title: payload.title,
        description: payload.description,
        checklist: payload.checklist,
        sortOrder: row.sort_order,
        priority: priorityFromDb(row.priority),
        authorUserId: row.author_user_id,
        assigneeUserId: row.assignee_user_id,
        startDate: row.start_date,
        dueDate: row.due_date,
        estimateMinutes: row.estimate_minutes,
        milestoneId: row.milestone_id,
        archived: row.archived_at !== null,
        archivedAt: row.archived_at,
        messageCount: row.message_count,
        unread,
        created: row.created,
        updated: row.updated
    });
}

// --------------------------------------------------------------- historique

/** Ce qu'un événement de la frise porte, chiffré sous l'étage du projet. */
export interface StoredEvent {
    label: string;
    from: string | null;
    to: string | null;
}

/**
 * Inscrit un fait dans l'histoire du projet.
 *
 * **Ne lève jamais** : la mutation qui l'appelle a déjà eu lieu, et perdre une
 * ligne de frise ne doit pas transformer un succès en erreur pour l'utilisateur.
 * Même posture que `ctx.audit`, dont c'est le pendant fonctionnel — l'audit
 * répond à « qui a fait quoi » du point de vue sécurité, la frise à « qu'est-il
 * arrivé à ce projet » du point de vue métier.
 */
export async function recordEvent(
    ctx: FeatureContext,
    project: ProjectRow,
    event: {
        kind: string;
        refType?: 'card' | 'milestone' | null;
        refId?: number | null;
        label: string;
        from?: string | null;
        to?: string | null;
    }
): Promise<void> {
    try {
        const payload: StoredEvent = {
            label: event.label,
            from: event.from ?? null,
            to: event.to ?? null
        };
        await ctx.db.projectHistory.record({
            projectId: project.id,
            workspaceId: ctx.workspaceId,
            actorUserId: ctx.userId,
            kind: event.kind,
            refType: event.refType ?? null,
            refId: event.refId ?? null,
            content: await cipherFor(ctx, project.security_tier).encrypt(JSON.stringify(payload))
        });
    } catch (e) {
        ctx.logger.warn({ err: e, projectId: project.id, kind: event.kind }, 'project: événement non enregistré');
    }
}

/**
 * Re-chiffre l'arbre entier d'un projet d'un étage vers l'autre.
 *
 * Tout est lu et re-chiffré **avant** la moindre écriture : si une seule ligne
 * résiste, on abandonne sans avoir rien touché, plutôt que de laisser un projet
 * à moitié converti dont la seconde moitié serait définitivement illisible.
 * Même parti pris que la conversion d'espace (`workspaceRekey`).
 *
 * Renvoie le `content` du projet lui-même, ré-encodé — la ligne `projects` est
 * écrite par l'appelant en même temps que `security_tier`, pour que le tier et
 * le corps ne puissent jamais diverger.
 */
export async function reencryptProjectTree(
    ctx: FeatureContext,
    row: ProjectRow,
    from: Cipher,
    to: Cipher
): Promise<string> {
    const plain = await from.tryDecrypt(row.content);
    if (plain === null) {
        throw new FeatureError('internal', 'Le corps du projet est illisible : conversion annulée.');
    }

    const cells = await ctx.db.projectRekey.readTree(row.id, ctx.workspaceId);
    const converted: typeof cells = [];
    for (const cell of cells) {
        const decrypted = await from.tryDecrypt(cell.value);
        if (decrypted === null) {
            throw new FeatureError(
                'internal',
                `Une ligne de ${cell.table} est illisible : conversion annulée, rien n’a été modifié.`
            );
        }
        converted.push({ ...cell, value: await to.encrypt(decrypted) });
    }

    for (const cell of converted) await ctx.db.projectRekey.write(row.id, cell);

    return to.encrypt(plain);
}
