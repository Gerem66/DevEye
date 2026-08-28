import { z } from 'zod';
import { projectCardSchema } from './board';

/**
 * Ce qui relie un projet au reste de DevEye, et ce qui relie une personne à ses
 * tâches à travers tous les projets.
 *
 * Deux notions transverses réunies ici parce qu'elles répondent à la même
 * question posée dans les deux sens : « qu'est-ce qui touche ce projet ? » et
 * « qu'est-ce qui me touche, moi, dans tous les projets ? ».
 */

/**
 * Ce qui relie un projet à un service surveillé.
 *
 * On ne stocke que l'identifiant : la cible garde ses propres droits, et rien
 * d'identifiant n'a besoin d'être chiffré. Un membre sans accès à Uptime voit
 * qu'il y a des services rattachés sans pouvoir les nommer — c'est la feature
 * visée qui tranche, pas celle-ci.
 *
 * La liaison est **non exclusive dans les deux sens** : un projet suit plusieurs
 * services, et un même service peut être suivi par plusieurs projets. Même forme
 * que la liaison au dépôt git, et pour la même raison — ce sont deux objets
 * d'espace, pas des propriétés d'un projet.
 */

/**
 * Une tâche qui m'est attribuée, vue depuis l'extérieur de son projet.
 *
 * `masked` marque une carte d'un projet confidentiel verrouillé : elle est
 * comptée et située, mais son titre reste illisible. La faire disparaître
 * donnerait une liste de tâches fausse, ce qui est pire que de dire « il y a
 * quelque chose ici que tu ne peux pas lire maintenant ».
 */
export const myTaskSchema = z.object({
    card: projectCardSchema,
    projectId: z.number().int().positive(),
    projectTitle: z.string(),
    masked: z.boolean()
});
export type MyTask = z.infer<typeof myTaskSchema>;

/**
 * L'intitulé d'un objet d'espace relié, tel que la feature visée le rend par
 * son contrat d'éléments (`labelOf`, sous le codec ouvert du DOMICILE du
 * projet). Une entrée par identifiant lié, toujours, chez soi comme depuis une
 * fenêtre : `label` vaut `null` quand le module est absent ou que l'élément a
 * disparu, et l'écran montre alors « un élément disparu », jamais un numéro.
 *
 * C'est ce qui rend une liaison lisible depuis une fenêtre sur un projet
 * projeté (`Docs/SHARING.md`) : le dépôt, la base, le site, la cible ou le
 * service vivent dans l'espace d'origine, que la fenêtre ne voit pas et ne
 * saurait nommer par ses propres listes. Le nom seul voyage ; ouvrir l'objet
 * reste un droit de l'espace d'origine, vérifié par sa feature.
 */
export const projectLinkLabelSchema = z.object({
    id: z.number().int().positive(),
    label: z.string().nullable()
});
export type ProjectLinkLabel = z.infer<typeof projectLinkLabelSchema>;

/**
 * Combien d'éléments chaque intégration d'un projet a à montrer.
 *
 * Des **compteurs seulement** : ils décident si l'écran a quelque chose à
 * ouvrir, pas ce qu'il montrera. Un projet neuf n'a ni dépôt, ni base, ni site,
 * ni déploiement — lui présenter quatre onglets vides revient à lui demander de
 * fouiller pour trouver le vide. Zéro fait donc disparaître l'onglet, et le
 * geste d'ajout se replie dans un menu unique.
 *
 * Les clés portent le nom de la **feature d'espace** pointée (`git`,
 * `database`, `audience`), pas celui de l'onglet qui les affiche : ce sont les
 * mêmes identifiants que les droits (`workspaceFeatureIdSchema`), et c'est ce
 * qui permet à l'appelant de demander « ai-je le droit d'y ajouter ? » sans
 * table de correspondance.
 *
 * Un compte ne dit rien de ce que l'appelant a le droit de **lire** : les
 * liaisons relèvent de `projects`, leur contenu de la feature visée. Un membre
 * sans accès à Git voit donc l'onglet Git et, dedans, la phrase qui explique ce
 * qui lui manque — plutôt qu'un onglet escamoté qui lui cacherait l'existence
 * même du lien.
 */
export const projectLinkCountsSchema = z.object({
    /** Dépôts reliés. */
    git: z.number().int().nonnegative(),
    /** Bases de données reliées. */
    database: z.number().int().nonnegative(),
    /** Sites suivis reliés. */
    audience: z.number().int().nonnegative(),
    /**
     * La cible de déploiement (0 ou 1) **plus** les services surveillés
     * rattachés. Les deux vivent dans le même onglet : compter la seule cible
     * ferait disparaître un onglet qui a encore de quoi répondre à « est-ce en
     * ligne ? ».
     */
    deploy: z.number().int().nonnegative()
});
export type ProjectLinkCounts = z.infer<typeof projectLinkCountsSchema>;

/** Ligne SQL (serveur uniquement). */
export interface ProjectUptimeLinkRow {
    project_id: number;
    service_id: number;
    workspace_id: number;
    created: number;
}

/**
 * Ligne SQL (serveur uniquement) : la liaison projet → base.
 *
 * Même forme que la liaison à un service surveillé, et pour la même raison :
 * la base est un objet d'espace que le projet ne fait que pointer. La table
 * (`project_database_links`, migration 068) appartient à Projets, pas au
 * module Bases de données, qui ne connaît ses projets que par le contrat
 * `PROJECTS_USAGE_PROVIDER`.
 */
export interface ProjectDatabaseLinkRow {
    project_id: number;
    database_id: number;
    workspace_id: number;
    created: number;
}

/** Ligne SQL (serveur uniquement) : la liaison projet → cible. */
export interface ProjectDeployLinkRow {
    project_id: number;
    target_id: number;
    workspace_id: number;
    created: number;
}

export interface ProjectRepoLinkRow {
    project_id: number;
    workspace_id: number;
    repo_id: number;
    created: number;
}

export interface ProjectAudienceLinkRow {
    project_id: number;
    site_id: number;
    workspace_id: number;
    created: number;
}
