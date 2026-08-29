import { AUDIENCE_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import Audience from './Audience';
import AudienceWidget from './AudienceWidget';
import { clientProvider } from './provider';
import SiteGeneralPanel from './SiteGeneralPanel';

export const clientEntry: FeatureClient = {
    Widget: AudienceWidget,
    Full: Audience,
    /**
     * Le panneau Général d'un site : la mesure, la reconnaissance des visiteurs
     * et la conservation des événements bruts. Partage et Permissions viennent
     * du descripteur.
     */
    settingsPanels: { general: SiteGeneralPanel },
    // Démonté dès la fermeture : la fiche tient des agrégats bornés par une fenêtre de
    // temps, qui vieilliraient en silence dans une instance mise en cache. Pas de
    // `holdSecrecy` : rien n'y est chiffré à l'étage gardé.
    cacheDurationMinutes: 0,
    /** Ce que Projets compose : la liste des sites, un site relié en entier, le dialogue. */
    providers: { [AUDIENCE_CLIENT_PROVIDER]: clientProvider }
};
