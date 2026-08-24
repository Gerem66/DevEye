import { SHARE_WIRED_FEATURES } from '@deveye/types';
import type { ForeignRef, WorkspaceFeatureId } from '@deveye/types';

import { createSecureStore, type Cipher } from '@/Services/SecureStore';

import { FeatureError, type FeatureContext } from './_define';

/**
 * Lire un élément qui n'habite pas l'espace où on le regarde.
 *
 * ## Le seul point du code qui déchiffre hors de son espace
 *
 * Un élément projeté reste chiffré sous la clé de son domicile. Pour le servir
 * ailleurs il faut donc le codec de **cet espace-là** — ce que
 * {@link ShareScope.cipherFor} rend, et rien d'autre dans le dépôt ne fait.
 *
 * Deux gardes rendent ça sûr, et il faut les deux :
 *
 *  1. **l'étage ouvert seulement.** `cipherFor` n'expose que `.open`. L'étage
 *     gardé d'un autre espace serait de toute façon illisible sans le mot de
 *     passe de son propriétaire, mais l'exposer laisserait croire le contraire ;
 *  2. **la projection doit exister.** Le codec n'est rendu que pour un espace
 *     d'origine effectivement présent dans les lignes `item_shares` chargées
 *     pour cet espace et cette feature. Un identifiant inventé par un appelant
 *     ne donne rien.
 *
 * La seconde est la vraie : sans elle, ce module serait un moyen de lire
 * l'étage ouvert de n'importe quel espace du serveur.
 *
 * ## Pourquoi un objet chargé une fois, et pas une fonction
 *
 * La question « d'où vient cette ligne ? » se pose pour **chaque** ligne d'un
 * listage. La poser à la base à chaque fois mettrait un aller-retour devant
 * chaque affichage ; les codecs, eux, se construisent une fois par espace
 * d'origine et se réutilisent.
 */

export interface ShareScope {
    /** Les identifiants projetés vers l'espace actif, par élément. */
    readonly foreignIds: ReadonlySet<number>;
    /** L'espace d'origine d'un élément projeté, ou `null` s'il est chez lui. */
    homeOf(itemId: number): number | null;
    /**
     * Le codec **ouvert** de l'espace où vit cet élément.
     *
     * Rend celui de l'espace actif quand l'élément est chez lui — le cas de
     * loin le plus courant, qui ne doit rien coûter de plus.
     */
    cipherFor(itemId: number): Promise<Cipher>;
}

/**
 * Charge, pour une feature, ce qui est projeté vers l'espace actif.
 *
 * Appelé une fois par commande de listage ou de lecture. Le résultat ne survit
 * pas à la commande : une projection retirée entre deux appels doit se voir au
 * suivant, pas au prochain redémarrage.
 */
export async function shareScope(ctx: FeatureContext, feature: WorkspaceFeatureId): Promise<ShareScope> {
    const rows = await ctx.db.itemSharing.sharedInto(ctx.workspaceId, feature);
    const homes = new Map<number, number>(rows.map((r) => [r.item_id, r.home_workspace_id]));
    const ciphers = new Map<number, Promise<Cipher>>();

    const openCipherOf = (workspaceId: number): Promise<Cipher> => {
        const cached = ciphers.get(workspaceId);
        if (cached) return cached;
        const built = buildOpenCipher(ctx, workspaceId);
        ciphers.set(workspaceId, built);
        return built;
    };

    return {
        foreignIds: new Set(homes.keys()),
        homeOf: (itemId) => homes.get(itemId) ?? null,
        cipherFor: async (itemId) => {
            const home = homes.get(itemId);
            // Chez lui, ou pas projeté du tout : le codec de l'espace actif.
            // Un identifiant absent de la carte ne peut pas obtenir de codec
            // étranger — c'est la garde qui empêche ce module d'être une porte
            // vers l'étage ouvert de n'importe quel espace.
            if (home === undefined || home === ctx.workspaceId) return ctx.secure.open;
            return openCipherOf(home);
        }
    };
}

/**
 * Le codec ouvert d'un espace donné.
 *
 * Résolu comme `_access.ts` le fait pour l'espace actif : la clé de l'espace
 * quand il en a une, celle de son propriétaire sinon. Les deux sont emballées
 * par la clé serveur, donc résolubles **sans session** — c'est ce qui rend la
 * projection possible, et c'est aussi sa limite (voir `shareTier`).
 */
async function buildOpenCipher(ctx: FeatureContext, workspaceId: number): Promise<Cipher> {
    const row = await ctx.db.workspaces.findById(workspaceId);
    if (!row) throw new FeatureError('not_found', 'Espace d’origine introuvable');

    const workspaceDekId = row.kind === 'shared' && (await ctx.secretKeys.hasWorkspaceDek(row.id)) ? row.id : null;
    const { store } = createSecureStore(
        ctx.db,
        ctx.crypt,
        { ownerUserId: row.owner_user_id, callerUserId: ctx.userId, workspaceDekId },
        ctx.sessionId
    );
    // `.open` et jamais le magasin entier : l'étage gardé d'un autre espace n'a
    // rien à faire ici, et le rendre accessible laisserait croire qu'il est
    // lisible — alors qu'il exigerait le mot de passe de son propriétaire.
    return store.open;
}

/**
 * Ce qu'un membre voit à la place d'une donnée qui ne lui est pas accessible.
 *
 * Le cas : un élément projeté vers B pointe une donnée de A — un compte mail, un
 * appareil, un canal d'alerte. Un membre de B qui n'est pas membre de A doit
 * **savoir que le lien existe** sans en connaître le contenu.
 *
 * Les deux extrêmes sont pires. Masquer le lien ferait passer un élément
 * correctement réglé pour un élément incomplet, et donnerait envie de le
 * re-régler par-dessus. Le montrer ferait fuiter le contenu d'un espace où l'on
 * n'entre pas. La ligne grise dit la vérité : « il y en a un, il ne vous
 * regarde pas ».
 */
export function foreignRef(label: string): ForeignRef {
    return { kind: 'inaccessible', label };
}

/**
 * L'appelant peut-il projeter des éléments de cette fonctionnalité ?
 *
 * Trois conditions, dans cet ordre — la première qui manque donne la cause
 * affichée :
 *
 *  1. la fonctionnalité doit s'y prêter (`shareTier`), question de chiffrement ;
 *  2. l'appelant doit pouvoir l'écrire — projeter, c'est décider où la donnée
 *     apparaît ;
 *  3. l'espace visé doit être un des siens, ce que le handler vérifie ensuite.
 */
export function shareBlockerFor(ctx: FeatureContext, feature: WorkspaceFeatureId): 'feature' | 'forbidden' | null {
    if (!SHARE_WIRED.has(feature)) return 'feature';
    if (!ctx.canFeature(feature, 'write')) return 'forbidden';
    return null;
}

const SHARE_WIRED = new Set<WorkspaceFeatureId>(SHARE_WIRED_FEATURES);
