/**
 * Le contrôle de démarrage sur l'autorisation.
 *
 * Même esprit que `buildTopicIndex` pour les `mutates` : attraper l'omission au
 * boot plutôt qu'en production. La différence est que celle-ci ne se voit pas —
 * un `mutates` oublié fige un écran, un `access` oublié **ouvre une commande**,
 * en silence, et l'interface qui masque la donnée donne au passage l'impression
 * que la garde existe.
 *
 * Ce n'est pas une hypothèse : au moment d'écrire ce fichier, `uptime`, `mail`,
 * `weather` et `cloudSync` — soit 76 commandes — n'en déclaraient **aucun**,
 * alors que les quatre sont accordables dans l'écran des rôles. Un membre dont
 * le rôle ne les accordait pas voyait l'interface masquée et pouvait appeler
 * chacune d'elles.
 */

/**
 * Les commandes qui n'ont **délibérément** pas d'`access` déclaratif.
 *
 * Trois familles, et chacune a sa raison :
 *
 *  - **le cycle de vie de l'espace** — s'en aller, en créer un, lire l'état de
 *    sa clé. Ces commandes ne visent pas le contenu d'un espace mais l'espace
 *    lui-même, et leur garde dépend de la ligne touchée (`isOwner`), ce qu'une
 *    déclaration statique ne sait pas dire ;
 *  - **ce que tout membre doit pouvoir lire** — la liste des rôles (chacun doit
 *    connaître ses propres droits), la liste des canaux (on ne route pas vers
 *    ce qu'on ne voit pas), sa propre présence ;
 *  - **ce dont la cible est un argument** — `notify.route*`, dont la
 *    fonctionnalité visée arrive dans l'entrée. Le dispatcheur ne peut pas
 *    vérifier avant le handler ce qu'il ne connaît pas encore ; le contrôle est
 *    en première ligne, comme pour `device.setConfig`.
 *
 * Toute autre commande doit déclarer son `access`. Ajouter une entrée ici est un
 * geste délibéré, qui se voit en revue — c'est tout l'objet de la liste.
 */
const ACCESS_EXEMPT = new Set([
    'workspace.activate',
    'workspace.add',
    'workspace.leave',
    'workspace.delete',
    'workspace.sharedKeyStatus',
    'workspace.enableSharedKey',
    'workspace.roleList',
    'device.list',
    'metrics.unsubscribe',
    'live.here',
    'notify.channelList',
    'notify.routeGet',
    'notify.routeSet',
    'notify.routeTest',
    // Même raison : la fonctionnalité visée arrive dans l'entrée. Le partage
    // vérifie en tête de handler l'accès à cette feature, l'appartenance à
    // l'espace cible et — pour les restrictions — `workspace.roles`.
    'share.get',
    'share.set',
    'share.grantList',
    'share.grantSet'
]);

/**
 * Refuse le démarrage si une commande n'est gardée par rien.
 *
 * Lever plutôt qu'avertir : un avertissement de boot se lit une fois puis se
 * range dans le bruit des journaux, et la commande reste ouverte pendant ce
 * temps. Le coût d'une entrée oubliée est une seconde de correction ; celui
 * d'une garde oubliée est une donnée servie à qui n'y a pas droit.
 */
export function assertAccessDeclared(defs: readonly { command: string; access?: unknown }[]): void {
    const naked = defs.filter((d) => !d.access && !ACCESS_EXEMPT.has(d.command)).map((d) => d.command);
    if (naked.length > 0) {
        throw new Error(
            `Commandes sans autorisation déclarée : ${naked.join(', ')}. ` +
                'Ajoutez un `access` à leur `defineFeature`, ou une entrée dans ACCESS_EXEMPT ' +
                'de src/features/_permissions.ts si l’absence est délibérée.'
        );
    }
}
