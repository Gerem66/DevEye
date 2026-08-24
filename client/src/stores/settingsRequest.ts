import type { FeatureId } from '@deveye/types';

/**
 * L'intention « ouvrir les réglages de tel élément, sur tel onglet ».
 *
 * Posée AVANT une bascule d'espace, consommée APRÈS : quand un réglage d'un
 * élément projeté se gère dans son espace d'origine, l'écran propose d'y
 * aller ; la bascule démonte tout, et c'est cette intention, qui vit hors de
 * l'arbre React comme la téléportation, qui rouvre les réglages au bon endroit
 * une fois la fiche de l'élément remontée là-bas.
 *
 * Le consommateur est UNIQUE et générique : le bouton de réglages
 * (`FeatureSettingsButton`) monté par la fiche de l'élément. C'est ce qui rend
 * le geste gratuit pour toutes les features : aucune n'a de code à écrire, il
 * suffit qu'elle monte le bouton commun, ce qui est la règle de toute façon.
 *
 * La péremption est large : entre la bascule, l'activation de l'espace, le
 * montage de la vue et l'ouverture de la fiche, plusieurs secondes passent.
 * Passé le délai, l'intention meurt en silence plutôt que d'ouvrir des
 * réglages que plus personne n'attend.
 */

const SETTINGS_INTENT_TTL_MS = 15_000;

interface SettingsIntent {
    workspaceId: number;
    feature: FeatureId;
    itemId: number;
    /** L'onglet demandé (`SettingsSectionId`) ; en `string` pour ne pas faire
     *  dépendre un store d'un composant. */
    section: string;
}

let intent: SettingsIntent | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function requestItemSettings(next: SettingsIntent): void {
    intent = next;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        intent = null;
        timer = null;
    }, SETTINGS_INTENT_TTL_MS);
}

/**
 * Consomme l'intention si elle vise exactement cet élément dans cet espace.
 * Rend l'onglet demandé, ou `null`. Une intention consommée ne rejoue pas.
 */
export function consumeItemSettings(workspaceId: number | null, feature: FeatureId, itemId: number): string | null {
    if (!intent || workspaceId === null) return null;
    if (intent.workspaceId !== workspaceId || intent.feature !== feature || intent.itemId !== itemId) return null;
    const section = intent.section;
    intent = null;
    if (timer) clearTimeout(timer);
    timer = null;
    return section;
}
