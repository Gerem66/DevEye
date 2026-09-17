import type { FeatureClient } from '@deveye/types/sdk/client';

import AccessPanel from './AccessPanel';
import GeneralPanel from './GeneralPanel';
import Mailserver from './Mailserver';
import MailserverWidget from './MailserverWidget';

export const clientEntry: FeatureClient = {
    Widget: MailserverWidget,
    Full: Mailserver,
    settingsPanels: { general: GeneralPanel, access: AccessPanel }
};
