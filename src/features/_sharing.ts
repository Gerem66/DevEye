import { SHARE_WIRED_FEATURES } from '@deveye/types';
import type { FeatureId, ForeignRef, WorkspaceFeatureId } from '@deveye/types';

import { createOpenCipher, type Cipher } from '@/Services/SecureStore';

import { FeatureError, type FeatureContext } from './_define';
import { isModuleShareWired } from './_sdk/register';

/**
 * Lire un élément qui n'habite pas l'espace où on le regarde : le seul point du
 * code qui déchiffre hors de son espace ({@link ShareScope.cipherFor}).
 *
 * Deux gardes, et il faut les deux : l'étage ouvert seulement (le gardé d'un
 * autre espace exigerait le mot de passe de son propriétaire), et la projection
 * doit exister dans les lignes `item_shares` chargées pour cet espace et cette
 * feature ; sans cette seconde garde, ce module lirait l'étage ouvert de
 * n'importe quel espace du serveur.
 *
 * Objet chargé une fois par commande : la question « d'où vient cette ligne ? »
 * se pose pour chaque ligne d'un listage.
 */

export interface ShareScope {
    /** Les identifiants projetés vers l'espace actif, par élément. */
    readonly foreignIds: ReadonlySet<number>;
    /** L'espace d'origine d'un élément projeté, ou `null` s'il est chez lui. */
    homeOf(itemId: number): number | null;
    /** Le codec ouvert de l'espace où vit cet élément (celui de l'espace actif s'il est chez lui). */
    cipherFor(itemId: number): Promise<Cipher>;
}

/**
 * Charge, pour une feature, ce qui est projeté vers l'espace actif. Le résultat
 * ne survit pas à la commande : une projection retirée doit se voir au suivant.
 */
export async function shareScope(ctx: FeatureContext, feature: FeatureId): Promise<ShareScope> {
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
            // Chez lui, ou pas projeté du tout : le codec de l'espace actif. Un
            // identifiant absent de la carte n'obtient jamais de codec étranger.
            if (home === undefined || home === ctx.workspaceId) return ctx.secure.open;
            return openCipherOf(home);
        }
    };
}

/**
 * Le codec ouvert d'un espace donné, résolu comme `_access.ts` le fait pour
 * l'espace actif. Emballé par la clé serveur, donc résoluble sans session :
 * c'est ce qui rend la projection possible, et sa limite (voir `shareTier`).
 */
async function buildOpenCipher(ctx: FeatureContext, workspaceId: number): Promise<Cipher> {
    const row = await ctx.db.workspaces.findById(workspaceId);
    if (!row) throw new FeatureError('not_found', 'Espace d’origine introuvable');
    return createOpenCipher(ctx.db, ctx.crypt, row.id);
}

/**
 * Ce qu'un membre voit à la place d'une donnée d'un espace où il n'entre pas
 * (un élément projeté qui pointe un compte mail, un appareil, un canal de son
 * domicile) : il doit savoir que le lien existe, sans en connaître le contenu.
 */
export function foreignRef(label: string): ForeignRef {
    return { kind: 'inaccessible', label };
}

/**
 * L'appelant peut-il projeter des éléments de cette fonctionnalité ? La
 * première condition qui manque donne la cause affichée ; l'appartenance à
 * l'espace visé est vérifiée ensuite par le handler.
 */
export function shareBlockerFor(ctx: FeatureContext, feature: FeatureId): 'feature' | 'forbidden' | null {
    if (!isShareWired(feature)) return 'feature';
    if (!ctx.canFeature(feature, 'write')) return 'forbidden';
    return null;
}

/**
 * La lecture élargie de cette fonctionnalité est-elle réellement branchée ?
 * Les natives par `SHARE_WIRED_FEATURES`, les modules par leur manifest.
 * `shareTier` dit ce que le chiffrement autorise ; ceci dit ce que le code fait.
 */
export function isShareWired(feature: FeatureId): boolean {
    return SHARE_WIRED.has(feature as WorkspaceFeatureId) || isModuleShareWired(feature);
}

const SHARE_WIRED = new Set<WorkspaceFeatureId>(SHARE_WIRED_FEATURES);
