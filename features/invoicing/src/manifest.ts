import { featureDescriptor } from '@deveye/types';

import { invoicingCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Le descriptif (intitulé, icône, nom de l'élément, palier de partage) est
 * celui du registre publié ; le manifest n'ajoute que ce que le registre ne
 * porte pas.
 *
 * L'élément de la feature est le **client**, pas le document : un espace
 * accumule des centaines de documents, et c'est le client qu'un rôle a une
 * raison de fermer. Un document hérite de la restriction du sien.
 */
const descriptor = featureDescriptor('invoicing');

export const manifest = {
    ...descriptor,
    category: 'work',
    resources: [
        'invoicing.count',
        'invoicing.dashboard',
        'invoicing.docList',
        'invoicing.doc',
        'invoicing.clientList',
        'invoicing.config'
    ],
    /**
     * Un brouillon se retouche vingt fois. Sans ce sujet, chaque enregistrement
     * ferait recalculer le tableau de bord et la carte d'accueil de tout
     * l'espace.
     */
    topics: [{ id: 'invoicingDrafts', keys: ['invoicing.docList', 'invoicing.doc'] }],
    /**
     * Deux limites plutôt qu'une : proposer et facturer ne sont pas le même
     * geste, et une seule enveloppe aurait fait payer au devis la place de sa
     * facture.
     */
    quotas: [
        { key: 'quotesPerMonth', label: 'devis émis par mois' },
        { key: 'invoicesPerMonth', label: 'factures émises par mois' }
    ],
    nativeCapabilities: ['notify', 'routes.public', 'mail.accounts'],
    /**
     * Deux droits, et seulement deux : le geste irréversible, et la cible d'une
     * fraude classique. Il n'y en a pas pour « voir les coordonnées d'un
     * client » : une facture EST l'identité d'un tiers plus un montant, sans le
     * nom et l'adresse elle est illisible et non conforme. Les coordonnées se
     * ferment en fermant le client, par les restrictions d'élément.
     */
    extraPermissions: [
        {
            key: 'issue',
            label: 'Émettre un document',
            description:
                'Numéroter et figer un devis, une facture ou un avoir. Sans ce droit, on rédige et on corrige des brouillons, on n’engage rien.',
            type: 'toggle'
        },
        {
            key: 'issuer',
            label: 'Modifier l’identité de l’émetteur',
            description:
                'Changer la dénomination, l’adresse, le SIRET, le numéro de TVA et les coordonnées bancaires qui figurent sur les documents.',
            type: 'toggle'
        }
    ],
    /**
     * Les onglets Notifications et Permissions ne se déclarent pas : la coquille
     * les ajoute d'elle-même, et le manifest les refuserait en double.
     */
    settings: {
        feature: [
            'general',
            { id: 'taxes', label: 'TVA', icon: 'finance' },
            { id: 'numbering', label: 'Numérotation', icon: 'list-numbered' },
            { id: 'wording', label: 'Mentions', icon: 'format' }
        ],
        /** L'élément est le client : son onglet Général porte son identité et son retrait. */
        item: ['general']
    },
    commands: invoicingCommands
} satisfies FeatureManifest;
