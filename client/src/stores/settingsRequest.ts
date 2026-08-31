import type { FeatureId } from '@deveye/types';

/**
 * L'intention « ouvrir les réglages de tel élément, sur tel onglet », posée avant
 * une bascule d'espace et consommée après : un élément projeté se règle dans son
 * espace d'origine, et la bascule démonte tout. L'intention vit donc hors de
 * l'arbre React, comme la téléportation, et meurt en silence passé le délai. Son
 * consommateur unique est `FeatureSettingsButton`, monté par la fiche.
 */

const SETTINGS_INTENT_TTL_MS = 15_000;

interface SettingsIntent {
    workspaceId: number;
    feature: FeatureId;
    itemId: string;
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
export function consumeItemSettings(workspaceId: number | null, feature: FeatureId, itemId: string): string | null {
    if (!intent || workspaceId === null) return null;
    if (intent.workspaceId !== workspaceId || intent.feature !== feature || intent.itemId !== itemId) return null;
    const section = intent.section;
    intent = null;
    if (timer) clearTimeout(timer);
    timer = null;
    return section;
}
