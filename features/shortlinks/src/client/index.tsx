import type { FeatureClient } from '@deveye/types/sdk/client';

import LinkAccessPanel from './LinkAccessPanel';
import LinkCampaignPanel from './LinkCampaignPanel';
import LinkGeneralPanel from './LinkGeneralPanel';
import Reports from './Reports';
import Shortlinks from './Shortlinks';
import ShortlinksWidget from './ShortlinksWidget';

export const clientEntry: FeatureClient = {
    Widget: ShortlinksWidget,
    Full: Shortlinks,
    AdminView: Reports,
    /** Les onglets d'un lien ; Domaines, Notifications, Partage et Permissions viennent de la coquille. */
    settingsPanels: { general: LinkGeneralPanel, access: LinkAccessPanel, campaign: LinkCampaignPanel },
    // Démonté dès la fermeture : les chiffres sont bornés par une période, et
    // vieilliraient en silence dans une instance gardée en cache.
    cacheDurationMinutes: 0
};
