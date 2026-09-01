/**
 * Le contrôle de démarrage sur l'autorisation : attraper l'omission au boot
 * plutôt qu'en production. Un `access` oublié ouvre une commande en silence,
 * et l'interface qui masque la donnée fait croire que la garde existe.
 */

/**
 * Les commandes qui n'ont délibérément pas d'`access` déclaratif :
 *  - le cycle de vie de l'espace, dont la garde dépend de la ligne touchée
 *    (`isOwner`) ;
 *  - ce que tout membre doit pouvoir lire (ses rôles, les canaux, sa présence) ;
 *  - ce dont la cible est un argument (`notify.*`, `share.*`) : la
 *    fonctionnalité visée arrive dans l'entrée, le contrôle est en première
 *    ligne du handler.
 * Toute autre commande doit déclarer son `access`.
 */
const ACCESS_EXEMPT = new Set([
    'workspace.activate',
    'workspace.add',
    'workspace.leave',
    'workspace.delete',
    'workspace.roleList',
    'agent.unsubscribe',
    'live.here',
    'notify.channelList',
    'notify.routeGet',
    'notify.routeSet',
    'notify.routeTest',
    // Chaque handler ouvre sur `ctx.assertChannels(...)`.
    'notify.channelAdd',
    'notify.channelUpdate',
    'notify.channelUsage',
    'notify.channelDelete',
    'notify.channelReorder',
    'notify.channelTest',
    // Le partage vérifie en tête de handler l'accès à la feature, l'appartenance
    // à l'espace cible et, pour les restrictions, `workspace.roles`.
    'share.get',
    'share.set',
    'share.grantList',
    'share.grantSet',
    // Le déplacement ouvre de même : écriture sur la feature et sur l'élément
    // chez lui, puis le droit d'écrire dans l'espace visé.
    'share.movePreview',
    'share.move'
]);

/**
 * Refuse le démarrage si une commande n'est gardée par rien. Lever plutôt
 * qu'avertir : un avertissement se range dans le bruit des journaux, et la
 * commande reste ouverte pendant ce temps.
 */
export function assertAccessDeclared(
    defs: readonly { command: string; access?: { feature?: string; extras?: readonly string[] } }[]
): void {
    const naked = defs.filter((d) => !d.access && !ACCESS_EXEMPT.has(d.command)).map((d) => d.command);
    if (naked.length > 0) {
        throw new Error(
            `Commandes sans autorisation déclarée : ${naked.join(', ')}. ` +
                'Ajoutez un `access` à leur `defineFeature`, ou une entrée dans ACCESS_EXEMPT ' +
                'de src/features/_permissions.ts si l’absence est délibérée.'
        );
    }
    // Une permission propre se résout contre le manifest de SA feature : sans
    // `feature`, le dispatcheur ne saurait pas où la chercher et laisserait
    // passer. L'omission doit coûter le démarrage, pas une garde muette.
    const orphans = defs.filter((d) => (d.access?.extras?.length ?? 0) > 0 && !d.access?.feature).map((d) => d.command);
    if (orphans.length > 0) {
        throw new Error(
            `Commandes dont les permissions propres ne visent aucune fonctionnalité : ${orphans.join(', ')}. ` +
                'Un `access.extras` exige un `access.feature`.'
        );
    }
}
