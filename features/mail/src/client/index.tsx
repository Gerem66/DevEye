import { MAIL_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import Mail from './Mail';
import MailEncryptionPanel from './MailEncryptionPanel';
import MailGeneralPanel from './MailGeneralPanel';
import MailSyncPanel from './MailSyncPanel';
import MailWidget from './MailWidget';
import { clientProvider } from './provider';

export const clientEntry: FeatureClient = {
    Widget: MailWidget,
    Full: Mail,
    /**
     * Général à l'échelle de la feature ET d'un compte (les réglages de l'espace,
     * les deux fois, pour que le bouton en haut à droite porte tout d'un coup),
     * Synchronisation et Chiffrement à l'échelle d'un compte. Le manifest déclare
     * les onglets, l'entrée fournit les panneaux.
     */
    settingsPanels: { general: MailGeneralPanel, sync: MailSyncPanel, encryption: MailEncryptionPanel },
    // Unmounted as soon as it closes: folders and messages are fetched live and
    // would go stale sitting in a cached instance.
    cacheDurationMinutes: 0,
    // Reads/writes password-encrypted data: hold the DEK alive while the view is
    // open so a long edit never trips the re-validation prompt.
    holdSecrecy: true,
    /** Ce que le formulaire d'un canal e-mail compose : les expéditeurs prêts, et le dialogue de compte. */
    providers: { [MAIL_CLIENT_PROVIDER]: clientProvider }
};
