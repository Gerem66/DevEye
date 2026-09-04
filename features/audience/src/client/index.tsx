import { AUDIENCE_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import Audience from './Audience';
import AudienceWidget from './AudienceWidget';
import { clientProvider } from './provider';
import SiteFormsPanel from './SiteFormsPanel';
import SiteGeneralPanel from './SiteGeneralPanel';
import SiteTrafficPanel from './SiteTrafficPanel';

export const clientEntry: FeatureClient = {
    Widget: AudienceWidget,
    Full: Audience,
    /**
     * Le panneau Général d'un site : son identité, sa mesure, la reconnaissance
     * des visiteurs, la conservation des événements bruts et sa suppression.
     * Partage et Permissions viennent du descripteur.
     */
    settingsPanels: { general: SiteGeneralPanel, traffic: SiteTrafficPanel, forms: SiteFormsPanel },
    // Démonté dès la fermeture : la fiche tient des agrégats bornés par une fenêtre de
    // temps, qui vieilliraient en silence dans une instance mise en cache. Pas de
    // `holdSecrecy` : rien n'y est chiffré à l'étage gardé.
    cacheDurationMinutes: 0,
    /** Ce que Projets compose : la liste des sites, un site relié en entier, le dialogue. */
    providers: { [AUDIENCE_CLIENT_PROVIDER]: clientProvider }
};
