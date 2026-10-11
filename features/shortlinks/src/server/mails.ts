import type { SdkAccountMailMessage, SdkMailSample, SdkOrigins } from '@deveye/types/sdk/server';

import { SHORTLINK_REPORT_REASON_LABELS, type ShortlinkReportReason } from '../contracts/domain';

/**
 * Les mails du module, tous par l'expéditeur du serveur : un signalement va aux
 * modérateurs et aux administrateurs, sans l'adresse ni l'IP du signalant, et
 * la décision de retirer un lien va à son auteur, avec sa raison.
 */

export interface ReportMailInput {
    ref: string;
    url: string;
    title: string;
    target: string;
    reason: ShortlinkReportReason;
    message: string;
    reporterName: string;
    origins: SdkOrigins;
}

/** La modération ouverte sur Liens courts, par le lien d'arrivée de l'app. */
export function reportsPageUrl(origins: SdkOrigins): string {
    return `${origins.app}/?moderation=shortlinks`;
}

export function reportMail(input: ReportMailInput): SdkAccountMailMessage {
    const named = input.title.length > 0 ? `le lien « ${input.title} »` : 'un lien court';
    return {
        subject: `Signalement ${input.ref} : ${SHORTLINK_REPORT_REASON_LABELS[input.reason]}`,
        paragraphs: [
            `Un visiteur signale ${named}, à l’adresse ${input.url}.`,
            `Il mène à : ${input.target || 'destination illisible'}`,
            `Motif : ${SHORTLINK_REPORT_REASON_LABELS[input.reason]}`,
            `Message : ${input.message}`,
            `Signalé par : ${input.reporterName}`
        ],
        notice: 'Le lien continue de rediriger tant qu’aucune décision n’est prise. Retirez-le si la destination est manifestement trompeuse ou illicite.',
        button: { label: 'Examiner le signalement', url: reportsPageUrl(input.origins) },
        footnote: `Référence ${input.ref}. Vous recevez ce mail parce que vous modérez cette installation de DevEye.`
    };
}

export interface TakedownMailInput {
    title: string;
    url: string;
    note: string;
    ref: string;
    origins: SdkOrigins;
}

/** La décision motivée que doit recevoir l'auteur du lien retiré. */
export function takedownMail(input: TakedownMailInput): SdkAccountMailMessage {
    const terms = input.origins.site === null ? null : `${input.origins.site}/cgu`;
    const contact = input.origins.site === null ? null : `${input.origins.site}/mentions-legales`;
    const named = input.title.length > 0 ? `« ${input.title} »` : `${input.url}`;
    return {
        subject: `Votre lien ${named} a été retiré`,
        paragraphs: [
            `À la suite d’un signalement, l’administration du service a retiré votre lien court ${named}. Il affiche désormais « Lien retiré » au lieu de rediriger. Ses réglages et ses statistiques restent dans DevEye, et vous pouvez le supprimer vous-même.`,
            input.note.length > 0
                ? `Motif de la décision : ${input.note}`
                : 'Aucun motif détaillé n’a été joint à la décision.',
            contact === null
                ? 'Si vous estimez que cette décision est une erreur, contactez l’administration du service en citant la référence ci-dessous : elle sera réexaminée.'
                : `Si vous estimez que cette décision est une erreur, contactez l’administration du service (${contact}) en citant la référence ci-dessous : elle sera réexaminée.`
        ],
        button: { label: 'Ouvrir DevEye', url: input.origins.app },
        footnote: `Référence ${input.ref}.${terms === null ? '' : ` Conditions d’utilisation : ${terms}`}`
    };
}

/** Chaque mail du module, par les mêmes constructeurs qu'en vrai, sur des données d'exemple. */
export function shortlinksMailSamples(): SdkMailSample[] {
    return [
        {
            key: 'report',
            label: 'Lien signalé, vers la modération',
            sender: 'server',
            build: ({ origins }) =>
                reportMail({
                    ref: '3FA92C1B07DE',
                    url: `${origins.public}/l/k3x9p2`,
                    title: 'Offre de rentrée',
                    target: 'https://connexion-banque.exemple.net/verifier',
                    reason: 'phishing',
                    message: 'Ce lien imite la page de connexion de ma banque et demande mes identifiants.',
                    reporterName: 'Camille Martin',
                    origins
                })
        },
        {
            key: 'takedown',
            label: 'Lien retiré, vers son auteur',
            sender: 'server',
            build: ({ origins }) =>
                takedownMail({
                    title: 'Offre de rentrée',
                    url: `${origins.public}/l/k3x9p2`,
                    note: 'La destination imite la page de connexion d’une banque.',
                    ref: '3FA92C1B07DE',
                    origins
                })
        }
    ];
}
