import type { DiscordMessage } from '@/Services/discord';

import { COLOR_DANGER, block, footer, moment, trim } from './shared';

/**
 * L'avis d'échec de sauvegarde tel que Discord doit le montrer.
 *
 * **Un seul état, et c'est délibéré** : seuls les échecs sont annoncés. Une
 * sauvegarde qui réussit ne dit rien, sinon le canal se remplirait de succès
 * quotidiens et l'échec s'y perdrait — c'est précisément l'un des rares
 * messages qu'on ne peut pas se permettre de manquer.
 *
 * D'où l'absence de variante « rétablie », qui existe pour Uptime et les bases :
 * il n'y a rien à rétablir, seulement une exécution suivante à réussir.
 */

export interface BackupNotice {
    /** L'intitulé du travail de sauvegarde. */
    job: string;
    /** La destination visée, quand on la connaît. */
    destination: string | null;
    /** Le message d'erreur, tel que le moteur l'a produit. */
    error: string;
    at: number;
}

export function buildNotice(notice: BackupNotice): NonNullable<DiscordMessage['embeds']> {
    const fields: Record<string, unknown>[] = [
        { name: '💾 Travail', value: trim(notice.job), inline: true },
        { name: '📅 Échoué', value: moment(notice.at), inline: true }
    ];
    if (notice.destination) fields.push({ name: '📦 Destination', value: trim(notice.destination), inline: true });
    if (notice.error.trim()) fields.push({ name: '⚠️ Cause', value: block(notice.error) });

    return [
        {
            title: `🔴 Sauvegarde « ${trim(notice.job)} » en échec`,
            description:
                'Cette copie n’a pas été écrite. La prochaine exécution réessaiera, mais la fenêtre manquée ne se rattrape pas.',
            color: COLOR_DANGER,
            fields,
            timestamp: new Date(notice.at * 1000).toISOString(),
            footer: footer('sauvegardes')
        }
    ];
}
