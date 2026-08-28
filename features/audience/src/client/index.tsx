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
     * Le panneau Général d'un SITE : la mesure, la reconnaissance des
     * visiteurs et la conservation des événements bruts, sortis du dialogue
     * d'édition (la dette de la coquille, réglée au rapatriement). Partage et
     * Permissions viennent du descripteur.
     */
    settingsPanels: { general: SiteGeneralPanel },
    // Démonté dès la fermeture, comme Git et les bases : la fiche tient des
    // agrégats bornés par une fenêtre de temps, qui auraient vieilli en
    // silence dans une instance mise en cache. Pas de `holdSecrecy` : rien
    // n'y est chiffré à l'étage gardé, donc rien ne peut ouvrir l'invite.
    cacheDurationMinutes: 0,
    /** Ce que Projets compose : la liste des sites, un site relié en entier, le dialogue. */
    providers: { [AUDIENCE_CLIENT_PROVIDER]: clientProvider }
};
