import type { HomeSectionKind } from 'deveye-types';

/**
 * Single source of truth for how each section kind is worded and iconified, so
 * the section header, the "add a section" picker and the per-section add button
 * can never drift apart.
 */

/** Every kind the user can add a section of, in the order the picker lists them. */
export const SECTION_KINDS: HomeSectionKind[] = ['device', 'feature', 'shortcut'];

/** Kind name, shown as the muted chip in a section header and in the picker. */
export const SECTION_KIND_LABEL: Record<HomeSectionKind, string> = {
    device: 'Appareils',
    feature: 'Fonctionnalités',
    shortcut: 'Raccourcis'
};

/** One-liner under the kind name in the "add a section" picker. */
export const SECTION_KIND_DESC: Record<HomeSectionKind, string> = {
    device: 'Cartes de supervision de vos machines',
    feature: 'Météo, notes, mots de passe, mails…',
    shortcut: 'Liens épinglés vers vos sites'
};

export const SECTION_KIND_ICON: Record<HomeSectionKind, string> = {
    device: 'server',
    feature: 'sandbox',
    shortcut: 'move-to-right'
};

/** Label of the trailing "+" tile inside a section. */
export const ADD_TILE_LABEL: Record<HomeSectionKind, string> = {
    device: 'Ajouter un appareil',
    feature: 'Ajouter une fonctionnalité',
    shortcut: 'Créer un raccourci'
};

/** Title of the dialog that "+" tile opens. */
export const ADD_TILE_TITLE: Record<HomeSectionKind, string> = {
    device: 'Ajouter un appareil',
    feature: 'Ajouter une fonctionnalité',
    shortcut: 'Nouveau raccourci'
};
