import { featureDescriptor } from '@deveye/types';

import { uptimeCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Le descriptif (intitulé, icône, `notifies`, `hasItems`, `shareTier`) vient du
 * registre publié ; le manifest n'ajoute que ce que le registre ne porte pas.
 *
 * `shareTier: 'open'` engage : l'entrée `items` du serveur, `ctx.sharing.scope()`
 * dans les listages et `ctx.items.restrictions()` sur ce qu'ils rendent. Le boot
 * refuse un module qui déclare sans tenir.
 */
const descriptor = featureDescriptor('uptime');

export const manifest = {
    ...descriptor,
    category: 'supervision',
    /**
     * Ravivées par le sujet `uptime` : après une écriture, et à chaque transition
     * d'état signalée par le service de fond (jamais à chaque sonde).
     */
    resources: ['uptime.count', 'uptime.list', 'uptime.pageList'],
    /** Retoucher une page de statut ne relit ni la liste des services ni leur compte. */
    topics: [{ id: 'uptimePages', keys: ['uptime.pageList'] }],
    /** Un domaine vérifié ou retiré change l'adresse que la page donne à partager. */
    alsoInvalidatedBy: [{ topic: 'domain', keys: ['uptime.pageList'] }],
    /**
     * `notify` : les canaux d'alerte de l'espace, par service. `routes.public` :
     * les pages de statut, lisibles sans compte.
     */
    nativeCapabilities: ['notify', 'routes.public'],
    quotas: [
        { key: 'monitors', label: 'services surveillés', stock: true },
        { key: 'pages', label: 'pages de statut', stock: true }
    ],
    domains: {
        hint: 'Votre propre adresse pour une page de statut, comme statut.monentreprise.fr : la page y répond directement, à la racine. Sans elle, la page reste sur l’adresse de DevEye, qui fonctionne toujours.',
        service: 'Faites pointer le domaine vers DevEye avec l’enregistrement ci-dessous.',
        placeholder: 'statut.monentreprise.fr',
        removal: 'La page qu’il sert repart sur l’adresse de DevEye, et ce domaine cesse de l’afficher.',
        web: true
    },
    topbarWidget: { description: 'Services en ligne sur les services surveillés' },
    links: [{ to: 'mail', what: 'envoie ses alertes par un compte Mail' }],
    /**
     * À l'échelle d'un service, un panneau Général (identité, réglages fins,
     * suppression) et un panneau Intégrité (la relecture des fichiers et
     * l'acceptation après un déploiement). Notifications, Partage et
     * Permissions s'ajoutent tout seuls : `notifies` et le branchement au
     * partage suffisent. À l'échelle de la feature, les pages de statut et les
     * domaines qui les servent.
     */
    settings: {
        feature: [{ id: 'pages', label: 'Pages de statut', icon: 'eye-open' }, 'domains'],
        item: ['general', { id: 'integrity', label: 'Intégrité', icon: 'shield' }]
    },
    commands: uptimeCommands
} satisfies FeatureManifest;
