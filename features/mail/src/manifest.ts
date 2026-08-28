import { featureDescriptor } from '@deveye/types';

import { mailCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Mail, au format manifest : la treizième native rapatriée sur le SDK, et la
 * première à vivre sur les deux étages par COMPTE (une boîte ouverte se lit
 * sans session et se synchronise en fond ; une boîte gardée exige le
 * déverrouillage et ne se lit qu'en session), avec un service de fond (la
 * synchronisation IMAP des boîtes ouvertes), deux routes HTTP de l'app (le
 * téléchargement d'une pièce jointe et le retour OAuth, toutes deux sur un
 * ticket de session signé par l'hôte), et le contrat par lequel les alertes
 * e-mail des autres features partent (`MAIL_TRANSPORT_PROVIDER`).
 *
 * Le descriptif (intitulé, icône, phrase des rôles, `hasItems`, `itemNoun`,
 * `shareTier: 'perItem'`) reste celui du registre publié, étalé plutôt que
 * recopié : une native garde son identité dans @deveye/types, le manifest
 * n'ajoute que ce que le registre ne porte pas (catégorie, ressources,
 * capacités, onglets de réglages, commandes).
 *
 * `shareTier: 'perItem'` est un engagement, tenu compte par compte : l'entrée
 * `items` du serveur (domicile, intitulé et palier d'un compte : une boîte
 * ouverte se projette, une boîte gardée jamais), `ctx.sharing.scope()` dans
 * le listage (le codec choisi ligne par ligne) et `ctx.items.restrictions()`
 * sur ce qu'il rend. Le boot refuse un module qui déclare sans tenir.
 */
const descriptor = featureDescriptor('mail');

export const manifest = {
    ...descriptor,
    category: 'work',
    /**
     * Cinq clés de cache, telles que les écrans les invalident : le compte de
     * la carte d'accueil, la liste des comptes, les dossiers, la tête de liste
     * du dossier ouvert (fusionnée, jamais rechargée en entier) et les réglages
     * de l'espace. Le sujet `mail` les ravive toutes : après une écriture d'un
     * membre, et après chaque tour de synchronisation qui a changé quelque
     * chose.
     */
    resources: ['mail.accountCount', 'mail.accountList', 'mail.folderList', 'mail.messageList', 'mail.getSettings'],
    /**
     * Les routes publiques : le téléchargement d'une pièce jointe (une URL à
     * ticket, un GET nu pour que le navigateur télécharge nativement) et le
     * retour OAuth (la fenêtre de consentement revient ici). Les deux sur
     * l'origine de l'app seulement (`exposure: 'app'`).
     */
    nativeCapabilities: ['routes.public'],
    /**
     * Général à l'échelle de la feature (l'affichage des messages, les images
     * approuvées : les réglages de l'espace) ET d'un compte ; Synchronisation
     * (la cadence de relève d'une boîte, sa maintenance) et Chiffrement (le
     * palier d'une boîte, ouvert ou gardé, et son changement) à l'échelle d'un
     * compte. C'étaient les trois tables de câblage natif de la coquille
     * (GENERAL_WIRED, SYNC_WIRED, ENCRYPTION_WIRED), dont Mail était le dernier
     * occupant : elles disparaissent avec ce manifest.
     */
    settings: { feature: ['general'], item: ['general', 'sync', 'encryption'] },
    commands: mailCommands
} satisfies FeatureManifest;
