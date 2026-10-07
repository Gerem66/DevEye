import type {
    Project,
    ProjectCard,
    ProjectCardRow,
    ProjectChecklistItem,
    ProjectColumn,
    ProjectColumnRow,
    ProjectEventKind,
    ProjectLinkLabel,
    ProjectMilestoneColor,
    ProjectPriority,
    ProjectRow,
    ProjectSecurityTier,
    ProjectSummary,
    ProjectTag,
    ProjectTimelineZoom
} from '../contracts/domain';
import {
    PROJECT_CHECKLIST_LABEL_MAX_LENGTH,
    PROJECT_PRIORITIES,
    projectCardSchema,
    projectColumnSchema,
    projectMilestoneColorSchema,
    projectSchema,
    projectTimelineZoomSchema
} from '../contracts/domain';
import { FeatureError, type SdkCipher, type SdkFeatureContext, type SdkShareScope } from '@deveye/types/sdk/server';

import type { ProjectsRepo, ProjectStats } from './repo';

export type Ctx = SdkFeatureContext<ProjectsRepo>;

/** La lecture est le défaut du SDK : seules les écritures déclarent leur niveau. */
export const WRITE = { level: 'write' } as const;
/**
 * La seule permission propre qui garde une lecture, et donc la seule sans
 * `level` : la lecture est le niveau par défaut.
 */
export const HISTORY = { extras: ['history'] } as const;

/**
 * Les cinq surfaces que `write` ne suffit plus à ouvrir (voir le manifest).
 * Déclarées ici et non éprouvées dans les handlers : le dispatcheur les
 * applique, et `ctx.items.assert` les rapporte ensuite au projet visé, si bien
 * qu'un droit peut se confier sur un seul projet.
 */
export const MANAGE = { level: 'write', extras: ['manageProjects'] } as const;
export const TASKS = { level: 'write', extras: ['tasks'] } as const;
export const PLAN = { level: 'write', extras: ['plan'] } as const;
export const LINKS = { level: 'write', extras: ['links'] } as const;
export const CHAT = { level: 'write', extras: ['chat'] } as const;

/** Le niveau qu'une commande exige sur le projet qu'elle vise. */
export type ItemLevel = 'read' | 'write';

/**
 * Payload chiffré d'un projet (`projects.content`) : n'y vit que ce qui identifie,
 * le reste est en colonnes claires pour que le portefeuille se liste sans clé.
 */
export interface StoredProject {
    title: string;
    /** URL de données de la vignette, ou chaîne vide. */
    icon: string;
    description: string;
    tags: ProjectTag[];
    version: string;
    /** L'échelle d'ouverture de la frise. Ici et non en clair : rien ne la requête. */
    timelineZoom: ProjectTimelineZoom;
}

/**
 * L'étage sous lequel vit l'arbre d'un projet d'ici, par son palier. Choisir le
 * chiffre est le contrôle d'accès : un projet gardé ne se lit ni ne s'écrit tant que
 * la session n'est pas déverrouillée, sans qu'aucune garde n'ait à le dire, et le
 * palier est une colonne en clair pour que ce choix précède toute lecture.
 *
 * Pour un projet existant, voir {@link projectCipher} : l'étage ouvert est celui de
 * son domicile, pas forcément celui d'ici. Ceci ne sert qu'à la création et à la
 * conversion d'étage, deux gestes du domicile.
 */
export function cipherFor(ctx: Ctx, tier: ProjectSecurityTier): SdkCipher {
    return tier === 'guarded' ? ctx.cipher('private') : ctx.cipher();
}

/** Vrai quand le projet vient d'un autre espace, qui le projette ici. */
export function isForeign(ctx: Ctx, row: ProjectRow): boolean {
    return row.workspace_id !== ctx.workspaceId;
}

/**
 * Le codec sous lequel l'arbre d'un projet existant est écrit, choisi projet par
 * projet : chez lui {@link cipherFor} par son palier, projeté d'ailleurs le codec
 * ouvert de son espace d'origine que seul `ctx.sharing.scope()` sait rendre. Le
 * déchiffrer avec celui d'ici rendrait des lignes que les listes prendraient pour
 * corrompues. Un projet projeté est toujours ouvert, l'étage ouvert du domicile
 * suffit donc. `scope` évite de recharger les projections dans un listage qui les a
 * déjà.
 */
export async function projectCipher(ctx: Ctx, row: ProjectRow, scope?: SdkShareScope): Promise<SdkCipher> {
    if (!isForeign(ctx, row)) return cipherFor(ctx, row.security_tier);
    return (scope ?? (await ctx.sharing.scope())).cipherFor(String(row.id));
}

/**
 * Refuse un geste réservé au domicile sur un projet projeté. Une fenêtre lit et
 * agit, le domicile configure (`Docs/SHARING.md` §2) : un geste reste chez lui dès
 * qu'il référence d'autres objets de l'espace d'origine, que la fenêtre ne voit pas
 * et auxquels elle substituerait les siens.
 */
export function assertAtHome(ctx: Ctx, row: ProjectRow, gesture: string): void {
    if (!isForeign(ctx, row)) return;
    throw new FeatureError(
        'validation',
        `Ce projet appartient à un autre espace, qui le partage ici : ${gesture} se règle dans son espace d’origine.`
    );
}

export async function encryptProject(cipher: SdkCipher, payload: StoredProject): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

export function parseProject(plain: string): StoredProject | null {
    try {
        const parsed = JSON.parse(plain) as Partial<StoredProject>;
        const zoom = projectTimelineZoomSchema.safeParse(parsed.timelineZoom);
        return {
            title: typeof parsed.title === 'string' ? parsed.title : '',
            icon: typeof parsed.icon === 'string' ? parsed.icon : '',
            description: typeof parsed.description === 'string' ? parsed.description : '',
            tags: Array.isArray(parsed.tags) ? (parsed.tags as ProjectTag[]) : [],
            version: typeof parsed.version === 'string' ? parsed.version : '',
            timelineZoom: zoom.success ? zoom.data : 'week'
        };
    } catch {
        return null;
    }
}

/** Propage l'erreur du chiffre, `locked` compris : c'est l'invite du client. */
export async function decryptProject(cipher: SdkCipher, content: string): Promise<StoredProject | null> {
    return parseProject(await cipher.decrypt(content));
}

/** Variante non levante, pour les listes où une ligne fautive ne doit pas tout casser. */
export async function tryDecryptProject(cipher: SdkCipher, content: string): Promise<StoredProject | null> {
    const plain = await cipher.tryDecrypt(content);
    return plain === null ? null : parseProject(plain);
}

/**
 * Le DTO d'un projet. Les identifiants d'utilisateurs voyagent tels quels : c'est le
 * client qui nomme, parmi les membres de l'espace actif, et masque le reste.
 */
export function toProject(row: ProjectRow, payload: StoredProject, foreign: boolean): Project {
    return projectSchema.parse({
        id: row.id,
        title: payload.title,
        icon: payload.icon,
        description: payload.description,
        tags: payload.tags,
        version: payload.version,
        versionSource: row.version_source,
        showOverview: row.show_overview === 1,
        showTimeline: row.show_timeline === 1,
        timelineZoom: payload.timelineZoom,
        status: row.status,
        securityTier: row.security_tier,
        startDate: row.start_date,
        dueDate: row.due_date,
        sortOrder: row.sort_order,
        authorUserId: row.user_id,
        archived: row.archived_at !== null,
        foreign,
        created: row.created,
        updated: row.updated
    });
}

/**
 * La ligne de portefeuille d'un projet illisible : ses compteurs, et un corps vide
 * marqué `masked`. La liste doit dire qu'un projet existe même verrouillée, le faire
 * disparaître laisserait croire à une perte. Jamais projeté, un projet gardé n'étant
 * visible que chez lui.
 */
export function toMaskedSummary(row: ProjectRow, stats: ProjectStats | undefined): ProjectSummary {
    // Icône vide comprise : une vignette identifie autant qu'un titre, la laisser
    // passer sur un projet verrouillé viderait la garde de son sens.
    return withStats(
        toProject(row, { title: '', icon: '', description: '', tags: [], version: '', timelineZoom: 'week' }, false),
        true,
        stats,
        false
    );
}

export function toSummary(
    row: ProjectRow,
    payload: StoredProject,
    stats: ProjectStats | undefined,
    foreign: boolean
): ProjectSummary {
    return withStats(toProject(row, payload, foreign), false, stats, foreign);
}

function withStats(
    project: Project,
    masked: boolean,
    stats: ProjectStats | undefined,
    foreign: boolean
): ProjectSummary {
    return {
        project,
        masked,
        foreign,
        cardTotal: stats?.card_total ?? 0,
        cardDone: stats?.card_done ?? 0,
        cardOverdue: stats?.card_overdue ?? 0,
        nextDueDate: stats?.next_due_date ?? null,
        unread: stats?.unread ?? 0
    };
}

/**
 * Un projet visible depuis cet espace : le sien, ou un qu'un autre espace y projette.
 * Lève `not_found` sinon, sans trahir l'existence d'un projet invisible d'ici.
 * `ctx.items.assert` refuse en plus, au niveau demandé, les projets qu'une
 * restriction de rôle masque ou passe en lecture seule. Tout l'arbre suit le
 * domicile du projet : c'est `row.workspace_id`, jamais l'espace actif, que les
 * écritures prennent.
 */
export async function loadProject(ctx: Ctx, projectId: number, level: ItemLevel = 'read'): Promise<ProjectRow> {
    const row = await ctx.repo.projects.findVisible(projectId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Projet introuvable');
    await ctx.items.assert(String(projectId), level);
    return row;
}

/**
 * Le palier `guarded` n'a de sens que dans un espace personnel : ce qui protège un
 * projet confidentiel n'est pas un contrôle d'accès mais la DEK emballée par le mot
 * de passe, et dans un espace partagé les deux étages utilisent la clé de l'espace.
 * Le projet y serait lisible par tous tout en s'annonçant confidentiel, ce qui est
 * pire que le refus. Corollaire : un projet gardé ne connaît aucune restriction de
 * rôle, sa conversion peut tout oublier d'un geste (`ctx.items.forget`).
 */
export function assertGuardedAllowed(ctx: Ctx, tier: ProjectSecurityTier): void {
    if (tier !== 'guarded' || ctx.workspace.kind === 'personal') return;
    throw new FeatureError(
        'validation',
        'Un projet confidentiel n’existe que dans votre espace personnel : dans un espace partagé, ' +
            'il serait lisible par tous les membres tout en s’annonçant confidentiel.'
    );
}

/**
 * Garde les chemins qui écrivent ou détruisent un projet gardé. Le chiffrement
 * protège les lectures, mais une archive ou un renommage n'a pas besoin de lire le
 * corps : sans cette garde, une session verrouillée écraserait un projet qu'elle ne
 * peut pas voir. Lève `locked`, que le client transforme en invite.
 */
export async function assertProjectUnlocked(ctx: Ctx, row: ProjectRow): Promise<void> {
    if (row.security_tier !== 'guarded') return;
    if (!(await ctx.secrecy.isUnlocked())) {
        throw new FeatureError(
            'locked',
            'Le chiffrement par mot de passe est verrouillé ; saisissez-le pour continuer'
        );
    }
}

/**
 * Un membre de l'espace actif, propriétaire compris. Les assignés d'une carte et les
 * mentions d'un message ne peuvent viser que des membres d'ici, même sur un projet
 * projeté : c'est parmi les gens qu'on voit qu'on assigne, et un identifiant que
 * l'espace d'origine ne connaît pas s'y affiche masqué.
 */
export async function isMember(ctx: Ctx, userId: number): Promise<boolean> {
    const members = await ctx.deveye.members.list();
    return members.some((m) => m.userId === userId);
}

// ---------------------------------------------------------------- liaisons

/** Ce que Projets lit d'un contrat d'éléments pour nommer une liaison. */
interface ItemLabeller {
    labelOf(itemId: number, workspaceId: number): Promise<string | null>;
}

/**
 * Les intitulés d'objets d'espace reliés, une entrée par identifiant, toujours
 * remplie. `homeWorkspaceId` est le domicile du projet, jamais l'espace actif : les
 * liaisons y vivent, et un dépôt de là-bas ne se nomme que sous le codec ouvert de
 * là-bas. Module absent ou élément disparu valent `null`.
 */
export async function linkLabels(
    provider: ItemLabeller | undefined,
    ids: number[],
    homeWorkspaceId: number
): Promise<ProjectLinkLabel[]> {
    return Promise.all(
        ids.map(async (id) => ({ id, label: provider ? await provider.labelOf(id, homeWorkspaceId) : null }))
    );
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

export async function encryptColumn(cipher: SdkCipher, payload: StoredColumn): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

export async function encryptCard(cipher: SdkCipher, payload: StoredCard): Promise<string> {
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

/** Le corps est une entrée non validée : chaque item en sort complet, `toCard` le parse strictement ensuite. */
function parseChecklist(value: unknown): ProjectChecklistItem[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((raw): ProjectChecklistItem[] => {
        const item = (raw ?? {}) as Partial<ProjectChecklistItem>;
        if (typeof item.id !== 'string' || typeof item.label !== 'string') return [];
        const stamp = (v: unknown): number | null => (typeof v === 'number' ? v : null);
        return [
            {
                id: item.id,
                label: item.label.slice(0, PROJECT_CHECKLIST_LABEL_MAX_LENGTH),
                done: item.done === true,
                assigneeUserId: stamp(item.assigneeUserId),
                required: item.required === true,
                createdAt: stamp(item.createdAt),
                doneAt: stamp(item.doneAt),
                doneBy: stamp(item.doneBy)
            }
        ];
    });
}

function parseCard(plain: string): StoredCard {
    try {
        const parsed = JSON.parse(plain) as Partial<StoredCard>;
        return {
            title: typeof parsed.title === 'string' ? parsed.title : '',
            description: typeof parsed.description === 'string' ? parsed.description : '',
            checklist: parseChecklist(parsed.checklist)
        };
    } catch {
        return { title: '', description: '', checklist: [] };
    }
}

/**
 * Déchiffre une colonne sans jamais lever : une colonne dont le nom résiste doit
 * rester affichable, et ses cartes déplaçables, plutôt que de faire disparaître le
 * tableau entier.
 */
export async function decryptColumn(cipher: SdkCipher, content: string): Promise<StoredColumn> {
    const plain = await cipher.tryDecrypt(content);
    return plain === null ? { name: '' } : parseColumn(plain);
}

export async function decryptCard(cipher: SdkCipher, content: string): Promise<StoredCard> {
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

/** L'indice dans `PROJECT_PRIORITIES` est la valeur stockée (TINYINT). */
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

// -------------------------------------------------------------------- jalons

/** Payload chiffré d'un jalon (`project_milestones.content`). */
export interface StoredMilestone {
    name: string;
    description: string;
    color: ProjectMilestoneColor | null;
}

export async function encryptMilestone(cipher: SdkCipher, payload: StoredMilestone): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

/** Ne lève jamais : un jalon illisible reste sur la frise, sans son nom. */
export async function decryptMilestone(cipher: SdkCipher, content: string): Promise<StoredMilestone> {
    const empty: StoredMilestone = { name: '', description: '', color: null };
    const plain = await cipher.tryDecrypt(content);
    if (plain === null) return empty;
    try {
        const parsed = JSON.parse(plain) as Partial<StoredMilestone>;
        return {
            name: typeof parsed.name === 'string' ? parsed.name : '',
            description: typeof parsed.description === 'string' ? parsed.description : '',
            color: projectMilestoneColorSchema.nullable().catch(null).parse(parsed.color)
        };
    } catch {
        return empty;
    }
}

// --------------------------------------------------------------- historique

/** Ce qu'un événement de la frise porte, chiffré sous l'étage du projet. */
export interface StoredEvent {
    label: string;
    from: string | null;
    to: string | null;
}

/**
 * Inscrit un fait dans l'histoire du projet, chez lui : la ligne porte le domicile du
 * projet et son codec, même quand le geste vient d'une fenêtre. L'acteur reste
 * l'appelant, que l'espace d'origine nommera s'il le connaît. Ne lève jamais, la
 * mutation qui l'appelle a déjà eu lieu et perdre une ligne de frise ne doit pas
 * transformer un succès en erreur.
 */
export async function recordEvent(
    ctx: Ctx,
    project: ProjectRow,
    event: {
        kind: ProjectEventKind;
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
        const cipher = await projectCipher(ctx, project);
        await ctx.repo.history.record({
            projectId: project.id,
            workspaceId: project.workspace_id,
            actorUserId: ctx.userId,
            kind: event.kind,
            refType: event.refType ?? null,
            refId: event.refId ?? null,
            content: await cipher.encrypt(JSON.stringify(payload))
        });
    } catch (e) {
        ctx.logger.warn({ err: e, projectId: project.id, kind: event.kind }, 'projects: événement non enregistré');
    }
}

/**
 * Re-chiffre l'arbre entier d'un projet d'un étage vers l'autre, un geste du
 * domicile. Tout est lu et re-chiffré avant la moindre écriture : si une seule ligne
 * résiste, on abandonne sans rien avoir touché plutôt que de laisser un projet à
 * moitié converti, dont la seconde moitié serait définitivement illisible.
 *
 * Renvoie le `content` du projet lui-même, ré-encodé : l'appelant l'écrit en même
 * temps que `security_tier`, pour que le palier et le corps ne divergent jamais.
 */
export async function reencryptProjectTree(ctx: Ctx, row: ProjectRow, from: SdkCipher, to: SdkCipher): Promise<string> {
    const plain = await from.tryDecrypt(row.content);
    if (plain === null) {
        throw new FeatureError('internal', 'Le corps du projet est illisible : conversion annulée.');
    }

    const cells = await ctx.repo.rekey.readTree(row.id, row.workspace_id);
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

    for (const cell of converted) await ctx.repo.rekey.write(row.id, cell);

    return to.encrypt(plain);
}
