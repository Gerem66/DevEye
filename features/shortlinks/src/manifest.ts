import { featureDescriptor } from '@deveye/types';
import type { FeatureManifest } from '@deveye/types/sdk';

import { shortlinksCommands } from './contracts/commands';

/**
 * Le descriptif (intitulé, icône, `notifies`, `hasItems`, `shareTier`) vient du
 * registre publié ; le manifest n'ajoute que ce que le registre ne porte pas.
 *
 * `shareTier: 'open'` : une redirection lit sa destination sans session, donc à
 * l'étage ouvert, et un lien se projette dans un autre espace comme un service
 * d'Uptime.
 */
const descriptor = featureDescriptor('shortlinks');

export const manifest = {
    ...descriptor,
    category: 'work',
    resources: ['shortlinks.count', 'shortlinks.list', 'shortlinks.get', 'shortlinks.stats', 'shortlinks.reports'],
    /** Les visites battent ce sujet, au plus une fois par minute : la fiche et la liste se relisent sans recharger le reste. */
    topics: [{ id: 'shortlinksStats', keys: ['shortlinks.stats', 'shortlinks.list', 'shortlinks.count'] }],
    /**
     * Un domaine vérifié ou retiré change l'adresse qu'un lien donne à partager.
     * La décision d'un modérateur relit la liste des signalements chez les autres.
     */
    alsoInvalidatedBy: [
        { topic: 'domain', keys: ['shortlinks.list', 'shortlinks.get'] },
        { topic: 'pending', keys: ['shortlinks.reports'] }
    ],
    /**
     * `routes.public` : les redirections, lisibles sans compte. `notify` : la
     * destination tombée et la limite des visites. `accounts.mail` : les
     * signalements à la modération et la décision à l'auteur du lien.
     * `geoip` : le pays des visiteurs, sans garder leur adresse.
     */
    nativeCapabilities: ['notify', 'routes.public', 'accounts.mail', 'geoip'],
    /**
     * Un lien coûte peu tant qu'il existe ; ce qui coûte, ce sont les visites
     * (une lecture, un compteur) et ce qu'un lien abusif fait courir au nom qui
     * le sert. Une visite : une personne, par lien et par jour UTC.
     */
    quotas: [
        { key: 'links', label: 'liens courts', stock: true },
        { key: 'visits', label: 'visites des liens par mois' }
    ],
    domains: {
        hint: 'Votre propre adresse pour vos liens, comme go.monentreprise.fr : chaque lien y prend le nom que vous lui donnez (go.monentreprise.fr/promo). Sans elle, vos liens restent sur l’adresse de DevEye, qui fonctionne toujours.',
        service: 'Faites pointer le domaine vers DevEye avec l’enregistrement ci-dessous.',
        placeholder: 'go.monentreprise.fr',
        removal:
            'Les liens qui l’utilisent gardent leur adresse sur DevEye, et leurs adresses sur ce domaine cessent de fonctionner.',
        web: true
    },
    adminTabs: [{ id: 'reports', label: 'Signalements', moderation: true }],
    /**
     * À l'échelle d'un lien, Général (titre, destinations, adresse, contrôle),
     * Accès (mot de passe, fin) et Campagne (paramètres ajoutés). Notifications,
     * Partage et Permissions s'ajoutent seuls. À l'échelle de la fonctionnalité,
     * les domaines.
     */
    settings: {
        feature: ['domains'],
        item: [
            'general',
            { id: 'access', label: 'Accès', icon: 'lock' },
            { id: 'campaign', label: 'Campagne', icon: 'activity' }
        ]
    },
    commands: shortlinksCommands
} satisfies FeatureManifest;
