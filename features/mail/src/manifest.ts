import { featureDescriptor } from '@deveye/types';

import { mailCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Mail, au format manifest : les deux étages par compte (une boîte ouverte se
 * lit sans session et se synchronise en fond, une boîte gardée exige le
 * déverrouillage), un service de fond, deux routes HTTP de l'app à ticket de
 * session, et le contrat par lequel partent les alertes e-mail des autres
 * features (`MAIL_TRANSPORT_PROVIDER`).
 *
 * `shareTier: 'perItem'` est un engagement, tenu compte par compte : l'entrée
 * `items` du serveur (domicile, intitulé et palier d'un compte),
 * `ctx.sharing.scope()` dans le listage et `ctx.items.restrictions()` sur ce
 * qu'il rend. Le boot refuse un module qui déclare sans tenir.
 */
const descriptor = featureDescriptor('mail');

export const manifest = {
    ...descriptor,
    category: 'work',
    /**
     * Les clés de cache, telles que les écrans les invalident. Le sujet `mail` les
     * ravive toutes : après une écriture d'un membre, et après chaque tour de
     * synchronisation qui a changé quelque chose.
     */
    resources: ['mail.accountCount', 'mail.accountList', 'mail.folderList', 'mail.messageList', 'mail.getSettings'],
    /**
     * Le téléchargement d'une pièce jointe (une URL à ticket, un GET nu pour que
     * le navigateur télécharge nativement) et le retour OAuth, tous deux sur
     * l'origine de l'app seulement (`exposure: 'app'`).
     */
    nativeCapabilities: ['routes.public'],
    /**
     * Général à l'échelle de la feature (l'affichage des messages, les images
     * approuvées) et d'un compte ; Synchronisation (la cadence de relève d'une
     * boîte, sa maintenance) et Chiffrement (le palier d'une boîte et son
     * changement) à l'échelle d'un compte.
     */
    settings: { feature: ['general'], item: ['general', 'sync', 'encryption'] },
    commands: mailCommands
} satisfies FeatureManifest;
