import type { FeatureClient } from '@deveye/types/sdk/client';

import Projects from './Projects';
import ProjectsWidget from './ProjectsWidget';

/**
 * Pas de `settingsPanels` : le manifest ne déclare aucun onglet de réglages
 * propre, un projet se règle dans son dialogue de profil. Le bouton commun
 * n'en est pas moins monté sur la fiche d'un projet, pour ce que la coquille
 * ajoute d'elle-même : Partage (un projet `open` se projette dans un autre
 * espace) et Permissions. Pas de `providers` non plus : ce que Projets offre aux
 * autres modules (`PROJECTS_USAGE_PROVIDER`, « quels projets utilisent cet
 * élément ») est un contrat serveur, et les onglets d'un projet composent
 * dans l'autre sens les contrats client de Git, Déploiement, Bases de
 * données, Audience et Uptime.
 */
export const clientEntry: FeatureClient = {
    Widget: ProjectsWidget,
    Full: Projects,
    // Démonté dès la fermeture, comme Mail et Uptime : le portefeuille, les
    // fils de discussion et la présence vivent en direct, une instance en
    // cache continuerait de travailler sans être vue.
    cacheDurationMinutes: 0,
    // Un projet confidentiel est chiffré par mot de passe (`securityTier:
    // 'guarded'`, son arbre entier avec lui) : garder la DEK vivante pendant
    // que l'écran est ouvert évite l'invite au milieu d'une saisie de carte ou
    // d'un message (voir `holdSecrecy` de WidgetPopup). Même décision que
    // les Notes et Mail.
    holdSecrecy: true
};
