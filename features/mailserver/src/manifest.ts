import { featureDescriptor } from '@deveye/types';
import type { FeatureManifest } from '@deveye/types/sdk';

import { mailserverCommands } from './contracts/commands';

/** Le descriptif vient du registre publié ; le manifest n'ajoute que ce que le registre ne porte pas. */
const descriptor = featureDescriptor('mailserver');

export const manifest = {
    ...descriptor,
    category: 'work',
    links: [{ to: 'mail', what: 'Une adresse hébergée ici se lit dans Mail, ajoutée d’un clic.' }],
    /** Le défi ACME du certificat se sert sur une route publique. */
    nativeCapabilities: ['routes.public'],
    quotas: [{ key: 'addresses', label: 'adresses hébergées', stock: true }],
    domains: {
        hint: 'Les domaines dont DevEye héberge les adresses. Une adresse ne se crée que sur un domaine vérifié.',
        service:
            'Publiez ces enregistrements : le MX amène le courrier jusqu’ici, SPF, DKIM et DMARC font accepter le vôtre chez les autres.',
        placeholder: 'exemple.fr',
        removal: 'Des adresses vivent encore sur ce domaine : le retrait est refusé tant qu’il en reste.'
    },
    resources: [
        'mailserver.count',
        'mailserver.list',
        'mailserver.get',
        'mailserver.appPasswordList',
        'mailserver.activity',
        'mailserver.queueList',
        'mailserver.serverStatus'
    ],
    /**
     * Le courrier qui passe a son propre sujet, battu par le moteur : une boîte
     * active ne doit pas faire recharger listes et réglages de tout l'espace.
     */
    topics: [{ id: 'mailserverFlow', keys: ['mailserver.count', 'mailserver.activity', 'mailserver.queueList'] }],
    invalidatedByTopic: [
        'mailserver.count',
        'mailserver.list',
        'mailserver.get',
        'mailserver.appPasswordList',
        'mailserver.serverStatus'
    ],
    /** Un domaine retiré ou qui retombe change ce que la liste dit de ses adresses. */
    alsoInvalidatedBy: [{ topic: 'domain', keys: ['mailserver.list', 'mailserver.get'] }],
    settings: {
        feature: ['general', 'domains'],
        item: ['general', { id: 'access', label: 'Accès', icon: 'key' }]
    },
    extraPermissions: [
        {
            key: 'managePasswords',
            label: 'Gérer les mots de passe',
            description:
                'Réinitialiser le mot de passe d’une adresse, créer et révoquer ses mots de passe d’application. Sans ce droit, l’écriture règle la boîte sans jamais pouvoir y entrer.',
            type: 'toggle'
        },
        {
            key: 'manageQueue',
            label: 'Gérer la file d’envoi',
            description: 'Relancer ou abandonner un message en attente de remise.',
            type: 'toggle'
        }
    ],
    commands: mailserverCommands
} satisfies FeatureManifest;
