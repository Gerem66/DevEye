import { z } from 'zod';
import {
    PROJECT_VERSION_MAX_LENGTH,
    projectDraftSchema,
    projectSchema,
    projectSecurityTierSchema,
    projectSummarySchema,
    projectVersionSourceSchema
} from './project';
import { projectStatusSchema } from '@deveye/types';
import {
    PROJECT_COLUMN_NAME_MAX_LENGTH,
    projectCardDraftSchema,
    projectCardSchema,
    projectColumnSchema
} from './board';
import { PROJECT_MESSAGE_MAX_LENGTH, PROJECT_MESSAGE_PAGE_SIZE, projectMessageSchema } from './chat';
import { projectCardDepSchema, projectMilestoneDraftSchema, projectMilestoneSchema } from './plan';
import { PROJECT_EVENT_PAGE_SIZE, projectEventSchema } from './history';
import { myTaskSchema, projectLinkCountsSchema, projectLinkLabelSchema } from './link';

/**
 * Commandes des projets. L'espace visé n'apparaît dans aucune entrée : il voyage sur
 * l'enveloppe WS et le dispatcheur le résout, appartenance vérifiée, avant le
 * handler.
 */

const projectId = z.number().int().positive();

/**
 * Le portefeuille : les projets actifs visibles d'ici avec leurs compteurs, ceux de
 * l'espace puis ceux qu'un autre espace y projette (`foreign`, lus sous le codec de
 * leur domicile). Jamais verrouillée : un projet `guarded` dont le corps ne se lit
 * pas revient `masked` plutôt qu'absent, la liste doit dire ce qui existe.
 * `archived: true` bascule sur l'ensemble disjoint des projets archivés.
 */
export const projectList = {
    command: 'projects.list' as const,
    input: z.object({ archived: z.boolean().optional() }),
    output: z.object({ projects: z.array(projectSummarySchema) })
};

/**
 * Compte les projets actifs visibles d'ici, les mêmes lignes que la liste. Aucune
 * ligne n'est déchiffrée : la tuile d'accueil affiche un nombre même verrouillée.
 */
export const projectCount = {
    command: 'projects.count' as const,
    input: z.object({}),
    output: z.object({ count: z.number().int().nonnegative() })
};

/**
 * Un projet en entier. Sur un projet `guarded` verrouillé, le serveur répond
 * `locked` et le client ouvre l'invite habituelle avant de rejouer l'appel.
 */
export const projectGet = {
    command: 'projects.get' as const,
    input: z.object({ projectId }),
    output: z.object({ project: projectSchema })
};

/**
 * Crée un projet. `securityTier` est figé à la création et ne se change ensuite
 * que par {@link projectSetSecurityTier}, qui re-chiffre tout l'arbre.
 */
export const projectAdd = {
    command: 'projects.add' as const,
    input: z.object({
        project: projectDraftSchema,
        securityTier: projectSecurityTierSchema
    }),
    output: z.object({ project: projectSchema })
};

/**
 * Modifie le profil d'un projet. Ne touche ni au palier ni à la source de version,
 * deux bascules à effets de bord qui ont leurs propres commandes.
 */
export const projectUpdate = {
    command: 'projects.update' as const,
    input: z.object({ projectId, project: projectDraftSchema }),
    output: z.object({ project: projectSchema })
};

/**
 * Pose la version affichée, et d'où elle vient. `github_release` exige un dépôt lié
 * et un projet `open` ; `version` est alors ignorée et recalculée par le service de
 * fond. Suivre les releases référence un dépôt de l'espace d'origine : refusé
 * (`validation`) sur un projet projeté, cela se règle chez lui.
 */
export const projectSetVersion = {
    command: 'projects.setVersion' as const,
    input: z.object({
        projectId,
        source: projectVersionSourceSchema,
        version: z.string().max(PROJECT_VERSION_MAX_LENGTH)
    }),
    output: z.object({ project: projectSchema })
};

export const projectSetStatus = {
    command: 'projects.setStatus' as const,
    input: z.object({ projectId, status: projectStatusSchema }),
    output: z.object({ project: projectSchema })
};

/**
 * Bascule l'étage de chiffrement et re-chiffre dans la foulée tout l'arbre du projet
 * sous la nouvelle clé. Exige une session déverrouillée dans les deux sens : on ne
 * re-chiffre pas ce qu'on ne peut pas lire. Passer en `guarded` désactive les
 * intégrations, qui ont besoin de lire sans session, et retire les projections du
 * projet, chiffré dès lors par le mot de passe de son auteur. Domicile seulement
 * (`validation` depuis une fenêtre).
 */
export const projectSetSecurityTier = {
    command: 'projects.setSecurityTier' as const,
    input: z.object({ projectId, securityTier: projectSecurityTierSchema }),
    output: z.object({ project: projectSchema })
};

/**
 * Archive un projet : il quitte le portefeuille sans que rien ne soit détruit. C'est
 * ce que « supprimer » fait dans l'interface, il n'existe volontairement aucune
 * commande de suppression dans ce module.
 */
export const projectArchive = {
    command: 'projects.archive' as const,
    input: z.object({ projectId }),
    output: z.object({ projectId })
};

export const projectRestore = {
    command: 'projects.restore' as const,
    input: z.object({ projectId }),
    output: z.object({ projectId })
};

/**
 * Ordonne le portefeuille : `projectIds` en est le contenu complet, dans son ordre
 * final. Ne touche jamais au corps chiffré, donc fonctionne sur des projets masqués.
 * Les projets d'ici seulement : un identifiant projeté est refusé (`validation`)
 * plutôt qu'ignoré, un projet que le rôle ne peut pas écrire est laissé de côté.
 */
export const projectReorder = {
    command: 'projects.reorder' as const,
    input: z.object({ projectIds: z.array(projectId).min(1) }),
    output: z.object({ projectIds: z.array(projectId) })
};

// ------------------------------------------------------------------ tableau

const columnId = z.number().int().positive();
const cardId = z.number().int().positive();

/**
 * Le tableau complet d'un projet, colonnes et cartes vivantes, en un aller-retour :
 * le client ne tient aucun cache normalisé, il re-sollicite. Exige une session
 * déverrouillée sur un projet confidentiel. `archived: true` renvoie à la place les
 * cartes archivées sans les colonnes, l'ensemble disjoint que lit l'historique.
 */
export const projectBoard = {
    command: 'projects.board' as const,
    input: z.object({ projectId, archived: z.boolean().optional() }),
    output: z.object({
        columns: z.array(projectColumnSchema),
        cards: z.array(projectCardSchema)
    })
};

export const projectColumnAdd = {
    command: 'projects.columnAdd' as const,
    input: z.object({
        projectId,
        name: z.string().min(1).max(PROJECT_COLUMN_NAME_MAX_LENGTH),
        countsAsDone: z.boolean(),
        wipLimit: z.number().int().positive().nullable()
    }),
    output: z.object({ column: projectColumnSchema })
};

export const projectColumnUpdate = {
    command: 'projects.columnUpdate' as const,
    input: z.object({
        columnId,
        name: z.string().min(1).max(PROJECT_COLUMN_NAME_MAX_LENGTH),
        countsAsDone: z.boolean(),
        wipLimit: z.number().int().positive().nullable()
    }),
    output: z.object({ column: projectColumnSchema })
};

/**
 * Supprime une colonne, la seule suppression du module : refusée (`conflict`) tant
 * qu'elle porte la moindre carte, archivée comprise. La contrainte SQL est en
 * CASCADE, sans cette garde des cartes disparaîtraient en silence.
 */
export const projectColumnRemove = {
    command: 'projects.columnRemove' as const,
    input: z.object({ columnId }),
    output: z.object({ columnId })
};

export const projectColumnReorder = {
    command: 'projects.columnReorder' as const,
    input: z.object({ projectId, columnIds: z.array(columnId).min(1) }),
    output: z.object({ columnIds: z.array(columnId) })
};

export const projectCardAdd = {
    command: 'projects.cardAdd' as const,
    input: z.object({ projectId, columnId, card: projectCardDraftSchema }),
    output: z.object({ card: projectCardSchema })
};

export const projectCardUpdate = {
    command: 'projects.cardUpdate' as const,
    input: z.object({ cardId, card: projectCardDraftSchema }),
    output: z.object({ card: projectCardSchema })
};

/**
 * Range une colonne : `cardIds` en est le contenu complet dans son ordre final, et
 * chaque carte listée est versée dans `columnId` au passage, tri interne et passage
 * d'une colonne à l'autre d'un seul geste. Ne touche jamais au corps chiffré, un
 * glisser-déposer fonctionne donc sans rien déverrouiller.
 */
export const projectCardMove = {
    command: 'projects.cardMove' as const,
    input: z.object({ columnId, cardIds: z.array(cardId) }),
    output: z.object({ columnId, cardIds: z.array(cardId) })
};

/**
 * Archive une carte : elle quitte le tableau sans que rien ne soit détruit. Il
 * n'existe volontairement aucune commande de suppression de carte.
 */
export const projectCardArchive = {
    command: 'projects.cardArchive' as const,
    input: z.object({ cardId }),
    output: z.object({ cardId })
};

export const projectCardRestore = {
    command: 'projects.cardRestore' as const,
    input: z.object({ cardId }),
    output: z.object({ cardId })
};

// ------------------------------------------------------------ planification

const milestoneId = z.number().int().positive();

/**
 * Les jalons du projet et le graphe des dépendances entre ses cartes. Séparé de
 * `projects.board` : les fusionner ferait payer les dépendances à chaque ouverture
 * du kanban, qui n'en a que faire.
 */
export const projectPlan = {
    command: 'projects.plan' as const,
    input: z.object({ projectId }),
    output: z.object({
        milestones: z.array(projectMilestoneSchema),
        deps: z.array(projectCardDepSchema)
    })
};

export const projectMilestoneAdd = {
    command: 'projects.milestoneAdd' as const,
    input: z.object({ projectId, milestone: projectMilestoneDraftSchema }),
    output: z.object({ milestone: projectMilestoneSchema })
};

export const projectMilestoneUpdate = {
    command: 'projects.milestoneUpdate' as const,
    input: z.object({ milestoneId, milestone: projectMilestoneDraftSchema }),
    output: z.object({ milestone: projectMilestoneSchema })
};

export const projectMilestoneSetReached = {
    command: 'projects.milestoneSetReached' as const,
    input: z.object({ milestoneId, reached: z.boolean() }),
    output: z.object({ milestone: projectMilestoneSchema })
};

/**
 * Retire un jalon. Ses cartes se retrouvent simplement sans jalon (`ON DELETE SET
 * NULL`) : un jalon ne porte aucun travail, seulement une date.
 */
export const projectMilestoneRemove = {
    command: 'projects.milestoneRemove' as const,
    input: z.object({ milestoneId }),
    output: z.object({ milestoneId })
};

export const projectCardSetMilestone = {
    command: 'projects.cardSetMilestone' as const,
    input: z.object({ cardId, milestoneId: milestoneId.nullable() }),
    output: z.object({ cardId, milestoneId: milestoneId.nullable() })
};

/**
 * Déclare que `cardId` est bloquée par `blockedByCardId`. Refusée (`validation`) si
 * elle fermerait un cycle, fût-ce par un chemin de dix arêtes ; le contrôle est fait
 * côté serveur, là où le graphe complet est connu.
 */
export const projectDepAdd = {
    command: 'projects.depAdd' as const,
    input: projectCardDepSchema,
    output: z.object({ dep: projectCardDepSchema })
};

export const projectDepRemove = {
    command: 'projects.depRemove' as const,
    input: projectCardDepSchema,
    output: projectCardDepSchema
};

// ----------------------------------------------------------------- git

/**
 * La liaison du projet vers un dépôt de l'espace : le dépôt n'appartient pas au
 * projet, il vit dans la feature Git avec son cache, sa synchronisation et ses
 * jetons. Ce qui suit ne fait que poser et retirer un pointeur.
 */

/**
 * Les dépôts liés au projet, dans l'ordre de la feature Git, et leur nom (`labels`,
 * une entrée par identifiant, `null` sans module ou sans dépôt). Plusieurs est le
 * cas normal : client, serveur et contrats partagés vivent chacun dans le sien.
 */
export const projectRepoList = {
    command: 'projects.repoList' as const,
    input: z.object({ projectId }),
    output: z.object({
        repoIds: z.array(z.number().int().positive()),
        labels: z.array(projectLinkLabelSchema)
    })
};

/**
 * Ajoute un dépôt existant au projet. Idempotente, et rend la liste complète pour
 * que l'appelant n'ait pas à la recomposer. Refusée sur un projet confidentiel : la
 * synchronisation tourne sans session, et relier un projet gardé à une entité
 * d'espace en clair révélerait par la bande ce qu'il contient. Domicile seulement
 * (`validation` depuis une fenêtre), une fenêtre ne voit pas les dépôts de l'espace
 * d'origine.
 */
export const projectRepoLink = {
    command: 'projects.repoLink' as const,
    input: z.object({ projectId, repoId: z.number().int().positive() }),
    output: z.object({ repoIds: z.array(z.number().int().positive()) })
};

/**
 * Retire une liaison, domicile seulement. Le dépôt et son cache survivent : ils
 * appartiennent à l'espace, et d'autres projets peuvent s'en servir.
 */
export const projectRepoUnlink = {
    command: 'projects.repoUnlink' as const,
    input: z.object({ projectId, repoId: z.number().int().positive() }),
    output: z.object({ repoIds: z.array(z.number().int().positive()) })
};

// ------------------------------------------------------------- transverse

/**
 * Toutes mes tâches, tous projets visibles d'ici confondus, chacun lu sous son
 * codec. Une seule requête, que rend possible `assignee_user_id` en clair. Les
 * cartes d'un projet confidentiel verrouillé reviennent masquées plutôt qu'absentes,
 * une liste de tâches incomplète serait pire qu'une liste qui dit ce qu'elle ne peut
 * pas lire.
 */
export const projectMyTasks = {
    command: 'projects.myTasks' as const,
    input: z.object({}),
    output: z.object({ tasks: z.array(myTaskSchema) })
};

/**
 * Combien d'éléments chaque intégration du projet a à montrer. Une seule commande
 * pour les quatre : elle sert une seule décision, quels onglets la fiche ouvre, et
 * les demander une par une ferait apparaître la barre d'onglets par morceaux. Ne
 * déchiffre rien et ne demande aucune session, ce sont des liaisons en clair ; un
 * projet confidentiel n'en a aucune et répond quatre zéros.
 */
export const projectLinkCounts = {
    command: 'projects.linkCounts' as const,
    input: z.object({ projectId }),
    output: z.object({ counts: projectLinkCountsSchema })
};

/**
 * Les services surveillés rattachés au projet, dans l'ordre d'Uptime, et leur nom
 * seulement (`labels`, `null` sans module ou sans service) : les états relèvent
 * d'Uptime, que le client lit par `uptime.list` quand son rôle le lui ouvre. Le nom
 * suffit à dire ce qui est relié, et depuis une fenêtre c'est la seule façon de
 * nommer un service d'un autre espace.
 */
export const projectUptimeList = {
    command: 'projects.uptimeList' as const,
    input: z.object({ projectId }),
    output: z.object({
        serviceIds: z.array(z.number().int().positive()),
        labels: z.array(projectLinkLabelSchema)
    })
};

/**
 * Rattache un service surveillé au projet. Idempotente, rend la liste complète, et
 * domicile seulement (`validation` depuis une fenêtre) comme toute liaison.
 */
export const projectUptimeLink = {
    command: 'projects.uptimeLink' as const,
    input: z.object({ projectId, serviceId: z.number().int().positive() }),
    output: z.object({ serviceIds: z.array(z.number().int().positive()) })
};

/** Retire la liaison, domicile seulement. Le service, lui, n'est pas touché. */
export const projectUptimeUnlink = {
    command: 'projects.uptimeUnlink' as const,
    input: z.object({ projectId, serviceId: z.number().int().positive() }),
    output: z.object({ serviceIds: z.array(z.number().int().positive()) })
};

/**
 * Les bases de données rattachées au projet, dans l'ordre de la feature Bases, et
 * leur nom (`labels`, comme {@link projectUptimeList}).
 */
export const projectDatabaseList = {
    command: 'projects.databaseList' as const,
    input: z.object({ projectId }),
    output: z.object({
        databaseIds: z.array(z.number().int().positive()),
        labels: z.array(projectLinkLabelSchema)
    })
};

/**
 * Rattache une base au projet. Idempotente, et refusée sur un projet confidentiel :
 * la liaison est une ligne en clair et la base vit à l'étage ouvert, exactement
 * comme pour un dépôt git. Domicile seulement.
 */
export const projectDatabaseLink = {
    command: 'projects.databaseLink' as const,
    input: z.object({ projectId, databaseId: z.number().int().positive() }),
    output: z.object({ databaseIds: z.array(z.number().int().positive()) })
};

/** Retire la liaison, domicile seulement. La base, elle, n'est pas touchée. */
export const projectDatabaseUnlink = {
    command: 'projects.databaseUnlink' as const,
    input: z.object({ projectId, databaseId: z.number().int().positive() }),
    output: z.object({ databaseIds: z.array(z.number().int().positive()) })
};

/**
 * Les sites suivis rattachés au projet, dans l'ordre de la feature Audience, et leur
 * nom (`labels`, comme {@link projectUptimeList}).
 */
export const projectAudienceList = {
    command: 'projects.audienceList' as const,
    input: z.object({ projectId }),
    output: z.object({
        siteIds: z.array(z.number().int().positive()),
        labels: z.array(projectLinkLabelSchema)
    })
};

/**
 * Rattache un site au projet. Idempotente, et refusée sur un projet confidentiel :
 * la liaison est une ligne en clair et le site vit à l'étage ouvert, exactement
 * comme un dépôt git ou une base. Domicile seulement.
 */
export const projectAudienceLink = {
    command: 'projects.audienceLink' as const,
    input: z.object({ projectId, siteId: z.number().int().positive() }),
    output: z.object({ siteIds: z.array(z.number().int().positive()) })
};

/** Retire la liaison, domicile seulement. Le site, lui, n'est pas touché. */
export const projectAudienceUnlink = {
    command: 'projects.audienceUnlink' as const,
    input: z.object({ projectId, siteId: z.number().int().positive() }),
    output: z.object({ siteIds: z.array(z.number().int().positive()) })
};

// ---------------------------------------------------------- déploiement

/**
 * La liaison du projet vers les cibles de déploiement de l'espace : comme un dépôt,
 * la cible n'appartient pas au projet et plusieurs projets peuvent viser la même.
 * Déclencher ne se fait pas ici mais par `deploy.trigger`, qui accepte un `projectId`
 * facultatif pour inscrire le fait dans la frise du projet.
 */
/**
 * Les cibles reliées, dans l'ordre de la feature Déploiement, et leur nom (`labels`,
 * comme {@link projectUptimeList}).
 */
export const projectDeployList = {
    command: 'projects.deployList' as const,
    input: z.object({ projectId }),
    output: z.object({
        targetIds: z.array(z.number().int().positive()),
        labels: z.array(projectLinkLabelSchema)
    })
};

/**
 * Rattache une cible au projet. Idempotente, et refusée sur un projet confidentiel :
 * la liaison est une ligne en clair, la cible vit à l'étage ouvert et son suivi
 * tourne sans session. Domicile seulement.
 */
export const projectDeployLink = {
    command: 'projects.deployLink' as const,
    input: z.object({ projectId, targetId: z.number().int().positive() }),
    output: z.object({ targetIds: z.array(z.number().int().positive()) })
};

/** Retire la liaison, domicile seulement. La cible et son historique survivent. */
export const projectDeployUnlink = {
    command: 'projects.deployUnlink' as const,
    input: z.object({ projectId, targetId: z.number().int().positive() }),
    output: z.object({ targetIds: z.array(z.number().int().positive()) })
};

// -------------------------------------------------------------- historique

/**
 * La frise verticale d'un projet, du plus récent au plus ancien. Pagination par
 * curseur remontant : `before` demande la page qui précède un événement donné, sans
 * lui on obtient le haut de la frise.
 */
export const projectEventList = {
    command: 'projects.eventList' as const,
    input: z.object({
        projectId,
        before: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(PROJECT_EVENT_PAGE_SIZE).optional()
    }),
    output: z.object({
        events: z.array(projectEventSchema),
        hasMore: z.boolean()
    })
};

// -------------------------------------------------------------- discussion

const messageId = z.number().int().positive();

/**
 * Le fil d'une carte, du plus ancien au plus récent. Pagination par curseur
 * remontant : `before` demande la page qui précède un message donné, le seul ordre
 * qui tienne dans un fil où l'on écrit par le bas. Sans lui, la fin du fil.
 */
export const projectMessageList = {
    command: 'projects.messageList' as const,
    input: z.object({
        cardId,
        before: messageId.optional(),
        limit: z.number().int().positive().max(PROJECT_MESSAGE_PAGE_SIZE).optional()
    }),
    output: z.object({
        messages: z.array(projectMessageSchema),
        hasMore: z.boolean()
    })
};

/**
 * Poste un message. Les `mentions` sont des identifiants de membres de l'espace, le
 * serveur refuse tout autre ; elles voyagent à part du texte, que le serveur ne lit
 * jamais pour le comprendre mais seulement pour le stocker chiffré.
 */
export const projectMessageSend = {
    command: 'projects.messageSend' as const,
    input: z.object({
        cardId,
        text: z.string().min(1).max(PROJECT_MESSAGE_MAX_LENGTH),
        mentions: z.array(z.number().int().positive()).max(32)
    }),
    output: z.object({ message: projectMessageSchema })
};

/** Retouche son propre message. Un autre auteur est refusé (`forbidden`). */
export const projectMessageEdit = {
    command: 'projects.messageEdit' as const,
    input: z.object({
        messageId,
        text: z.string().min(1).max(PROJECT_MESSAGE_MAX_LENGTH),
        mentions: z.array(z.number().int().positive()).max(32)
    }),
    output: z.object({ message: projectMessageSchema })
};

/**
 * Pose le point d'eau haute de lecture de l'appelant sur une carte : tout message
 * d'identifiant inférieur ou égal cesse d'être compté comme non lu. N'est pas une
 * mutation diffusée, une lecture est personnelle.
 */
export const projectMarkRead = {
    command: 'projects.markRead' as const,
    input: z.object({ cardId, lastMessageId: messageId }),
    output: z.object({ cardId, lastMessageId: messageId })
};

export const projectCommands = [
    projectList,
    projectCount,
    projectGet,
    projectAdd,
    projectUpdate,
    projectSetVersion,
    projectSetStatus,
    projectSetSecurityTier,
    projectArchive,
    projectRestore,
    projectReorder,
    projectBoard,
    projectColumnAdd,
    projectColumnUpdate,
    projectColumnRemove,
    projectColumnReorder,
    projectCardAdd,
    projectCardUpdate,
    projectCardMove,
    projectCardArchive,
    projectCardRestore,
    projectMessageList,
    projectMessageSend,
    projectMessageEdit,
    projectMarkRead,
    projectPlan,
    projectMilestoneAdd,
    projectMilestoneUpdate,
    projectMilestoneSetReached,
    projectMilestoneRemove,
    projectCardSetMilestone,
    projectDepAdd,
    projectDepRemove,
    projectEventList,
    projectRepoList,
    projectRepoLink,
    projectRepoUnlink,
    projectDeployList,
    projectDeployLink,
    projectDeployUnlink,
    projectMyTasks,
    projectLinkCounts,
    projectUptimeList,
    projectUptimeLink,
    projectUptimeUnlink,
    projectDatabaseList,
    projectDatabaseLink,
    projectDatabaseUnlink,
    projectAudienceList,
    projectAudienceLink,
    projectAudienceUnlink
] as const;
