import type {
    Project,
    ProjectCard,
    ProjectCardRow,
    ProjectChecklistItem,
    ProjectColumn,
    ProjectColumnRow,
    ProjectLinkLabel,
    ProjectPriority,
    ProjectRow,
    ProjectSecurityTier,
    ProjectSummary,
    ProjectTag
} from '../contracts/domain';
import { PROJECT_PRIORITIES, projectCardSchema, projectColumnSchema, projectSchema } from '../contracts/domain';
import { FeatureError, type SdkCipher, type SdkFeatureContext, type SdkShareScope } from '@deveye/types/sdk/server';

import type { ProjectsRepo, ProjectStats } from './repo';

/** Le contexte d'une commande de Projets : le contexte du SDK, sur le dépôt du module. */
export type Ctx = SdkFeatureContext<ProjectsRepo>;

/**
 * Depuis le rapatriement, la lecture est implicite (le défaut du SDK) : seules
 * les écritures déclarent leur niveau.
 */
export const WRITE = { level: 'write' } as const;

/** Le niveau qu'une commande exige sur le projet qu'elle vise. */
export type ItemLevel = 'read' | 'write';

/**
 * Payload chiffré d'un projet (`projects.content`). N'y vit que ce qui
 * identifie ; `status`, `security_tier`, `sort_order` et les dates restent en
 * colonnes claires pour que le portefeuille se liste et se trie sans clé.
 */
export interface StoredProject {
    title: string;
    /** URL de données de la vignette, ou chaîne vide. Chiffrée comme le titre. */
    icon: string;
    description: string;
    tags: ProjectTag[];
    version: string;
}

/**
 * L'étage sous lequel vit l'arbre d'un projet **d'ici**, par son palier.
 * Choisir le chiffre **est** le contrôle d'accès : un projet gardé ne se lit
 * ni ne s'écrit tant que la session n'est pas déverrouillée, sans qu'aucune
 * garde n'ait à le dire.
 *
 * `ctx.cipher()` est l'ex `ctx.secure.open` (l'étage ouvert, celui que le
 * service du module sait relire seul), `ctx.cipher('private')` l'ex
 * `ctx.secure` (l'étage gardé, qui n'existe que dans une session
 * déverrouillée). Le palier est une colonne en clair précisément pour que ce
 * choix se fasse avant de lire quoi que ce soit.
 *
 * Pour un projet **existant**, voir {@link projectCipher} : l'étage ouvert est
 * celui de son domicile, pas forcément celui d'ici. Ceci ne sert qu'à la
 * création et à la conversion d'étage, deux gestes du domicile.
 */
export function cipherFor(ctx: Ctx, tier: ProjectSecurityTier): SdkCipher {
    return tier === 'guarded' ? ctx.cipher('private') : ctx.cipher();
}

/** Vrai quand le projet vient d'un autre espace, qui le projette ici. */
export function isForeign(ctx: Ctx, row: ProjectRow): boolean {
    return row.workspace_id !== ctx.workspaceId;
}

/**
 * Le codec sous lequel l'arbre d'un projet **existant** est écrit, où qu'il
 * vive, **choisi projet par projet**.
 *
 * Chez lui, c'est {@link cipherFor} par son palier. Projeté d'ailleurs, c'est
 * le codec ouvert de son espace d'origine, que seul `ctx.sharing.scope()` sait
 * rendre (`Docs/SHARING.md` §3) : le déchiffrer avec celui d'ici rendrait des
 * lignes illisibles, que les listes prendraient pour des lignes corrompues. Un
 * projet projeté est toujours ouvert (`findVisible` ne rend pas d'autre
 * projection, et un projet gardé se projette d'autant moins qu'il est chiffré
 * par le mot de passe de son auteur), donc l'étage ouvert du domicile est
 * indispensable et suffisant.
 *
 * `scope` évite de recharger les projections dans un listage qui les a déjà.
 */
export async function projectCipher(ctx: Ctx, row: ProjectRow, scope?: SdkShareScope): Promise<SdkCipher> {
    if (!isForeign(ctx, row)) return cipherFor(ctx, row.security_tier);
    return (scope ?? (await ctx.sharing.scope())).cipherFor(row.id);
}

/**
 * Refuse un geste réservé au domicile sur un projet projeté.
 *
 * Une fenêtre lit et agit, le domicile configure (`Docs/SHARING.md` §2) : un
 * geste reste chez lui quand il **référence d'autres objets de l'espace
 * d'origine** que la fenêtre ne voit pas. Relier ou délier une liaison (un
 * dépôt, une base, un site, une cible, un service de là-bas), changer le
 * palier (le mot de passe d'un membre de là-bas), suivre les releases (un
 * dépôt de là-bas), classer le portefeuille (le rang de là-bas). Lui proposer
 * les objets d'ici relierait le projet à un autre monde. Le serveur refuse, et
 * l'écran ne propose pas.
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
        return {
            title: typeof parsed.title === 'string' ? parsed.title : '',
            icon: typeof parsed.icon === 'string' ? parsed.icon : '',
            description: typeof parsed.description === 'string' ? parsed.description : '',
            tags: Array.isArray(parsed.tags) ? (parsed.tags as ProjectTag[]) : [],
            version: typeof parsed.version === 'string' ? parsed.version : ''
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
 * Le DTO d'un projet ; `foreign` dit à l'écran qu'il regarde une fenêtre sur
 * un autre espace. Les identifiants d'utilisateurs (auteur) voyagent tels
 * quels : c'est le client qui nomme, parmi les membres de l'espace actif, et
 * masque un identifiant qu'il n'y trouve pas.
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
 * La ligne de portefeuille d'un projet illisible : ses compteurs, et un corps
 * vide marqué `masked`. La liste doit dire qu'un projet existe même
 * verrouillée : le faire disparaître laisserait croire à une perte. Même parti
 * pris que les notes privées. Jamais projeté : un projet gardé n'est visible
 * que chez lui.
 */
export function toMaskedSummary(row: ProjectRow, stats: ProjectStats | undefined): ProjectSummary {
    // Icône vide comprise : une vignette est aussi identifiante qu'un titre, et
    // la laisser passer sur un projet verrouillé viderait la garde de son sens.
    return withStats(
        toProject(row, { title: '', icon: '', description: '', tags: [], version: '' }, false),
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
 * Un projet visible depuis cet espace : le sien, ou un qu'un autre espace y
 * projette. Lève `not_found` sinon, sans trahir l'existence d'un projet qu'on
 * ne voit pas d'ici.
 *
 * `level` décide de la garde : `ctx.items.assert` refuse en plus les projets
 * qu'une restriction de rôle masque ou passe en lecture seule. La feature
 * seule ne suffit pas à répondre « ce projet-là m'est-il ouvert ? ». Tout son
 * arbre (colonnes, cartes, jalons, messages, événements, liaisons) suit son
 * domicile : la chaîne carte → projet remonte toujours jusqu'ici, et c'est
 * `row.workspace_id`, jamais l'espace actif, que les écritures prennent.
 */
export async function loadProject(ctx: Ctx, projectId: number, level: ItemLevel = 'read'): Promise<ProjectRow> {
    const row = await ctx.repo.projects.findVisible(projectId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Projet introuvable');
    await ctx.items.assert(projectId, level);
    return row;
}

/**
 * Le tier `guarded` n'a de sens que dans un espace personnel.
 *
 * Ce qui protège un projet confidentiel n'est pas un contrôle d'accès mais le
 * chiffrement : son arbre passe par l'étage gardé, c'est-à-dire la DEK emballée
 * par le mot de passe. Dans un espace partagé, les deux étages utilisent la clé
 * de l'espace : le projet serait lisible par tous tout en s'annonçant
 * confidentiel, ce qui est pire que le refus.
 *
 * Un espace partagé n'est pas pour autant en clair : son arbre est chiffré sous
 * la clé de l'espace, à l'étage ouvert.
 *
 * Corollaire pour le partage : un projet gardé ne vit que dans un espace
 * personnel, où aucune restriction de rôle n'a de sens ; sa conversion peut
 * donc oublier projections et restrictions d'un seul geste (`ctx.items.forget`).
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
 * protège les lectures, mais une archive ou un renommage n'a jamais besoin de
 * *lire* le corps : sans ça, une session verrouillée pourrait écraser un projet
 * qu'elle ne peut pas voir. Lève `locked`, que le client transforme en invite.
 * Sans effet sur un projet projeté, toujours ouvert.
 *
 * `ctx.secrecy.isUnlocked()` est l'ex `ctx.secure.isUnlocked()` : la même
 * question, posée au verrou du SDK.
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
 * Un membre de l'espace **actif**, propriétaire compris : l'ex
 * `workspaceMembers.isMember`, lu par la façade (`members.read`) plutôt que
 * dans la table. Les assignés d'une carte et les mentions d'un message ne
 * peuvent viser que des membres d'ici, même sur un projet projeté : c'est
 * parmi les gens qu'on voit qu'on assigne, et un identifiant que l'espace
 * d'origine ne connaît pas s'y affiche masqué.
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
 * Les intitulés d'objets d'espace reliés, une entrée par identifiant, par le
 * contrat d'éléments de la feature visée, TOUJOURS remplis (chez soi comme
 * depuis une fenêtre : deux écrans, une seule source de noms).
 *
 * `homeWorkspaceId` est le domicile du projet, jamais l'espace actif : les
 * liaisons y vivent, et un dépôt de là-bas ne se nomme que sous le codec
 * ouvert de là-bas. Module absent ou élément disparu : `null`, que l'écran
 * montre comme « un élément disparu », jamais un numéro.
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
 * Inscrit un fait dans l'histoire du projet, chez lui : la ligne porte le
 * domicile du projet et son codec, même quand le geste vient d'une fenêtre.
 * L'acteur reste l'appelant, membre d'ici : l'espace d'origine le nommera
 * s'il le connaît, et le masquera sinon.
 *
 * **Ne lève jamais** : la mutation qui l'appelle a déjà eu lieu, et perdre une
 * ligne de frise ne doit pas transformer un succès en erreur pour l'utilisateur.
 * Même posture que `ctx.audit`, dont c'est le pendant fonctionnel : l'audit
 * répond à « qui a fait quoi » du point de vue sécurité, la frise à « qu'est-il
 * arrivé à ce projet » du point de vue métier.
 */
export async function recordEvent(
    ctx: Ctx,
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
 * Re-chiffre l'arbre entier d'un projet d'un étage vers l'autre. Un geste du
 * domicile : les deux codecs sont ceux d'ici, et l'arbre est lu chez lui.
 *
 * Tout est lu et re-chiffré **avant** la moindre écriture : si une seule ligne
 * résiste, on abandonne sans avoir rien touché, plutôt que de laisser un projet
 * à moitié converti dont la seconde moitié serait définitivement illisible.
 *
 * Renvoie le `content` du projet lui-même, ré-encodé : la ligne `projects` est
 * écrite par l'appelant en même temps que `security_tier`, pour que le tier et
 * le corps ne puissent jamais diverger.
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
