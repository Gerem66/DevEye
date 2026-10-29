import { MAILSERVER_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import AccessPanel from './AccessPanel';
import GeneralPanel from './GeneralPanel';
import Mailserver from './Mailserver';
import MailserverWidget from './MailserverWidget';
import { clientProvider } from './provider';

export const clientEntry: FeatureClient = {
    Widget: MailserverWidget,
    Full: Mailserver,
    settingsPanels: { general: GeneralPanel, access: AccessPanel },
    /** Ce que Mail compose sur une boîte hébergée ici : l'onglet Accès de l'adresse. */
    providers: { [MAILSERVER_CLIENT_PROVIDER]: clientProvider }
};
