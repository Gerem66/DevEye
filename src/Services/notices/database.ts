import type { DiscordMessage } from '@/Services/discord';

import { COLOR_DANGER, COLOR_SUCCESS, block, footer, moment, trim } from './shared';

/**
 * L'alerte de base de données telle que Discord doit la montrer.
 *
 * Deux états seulement, et c'est ce qui gouverne la forme : une alerte se
 * **déclenche** puis **revient à la normale**. Les deux messages sont émis, dans
 * les deux sens, parce qu'une alerte qu'on ne voit pas se refermer laisse
 * croire que le problème dure.
 *
 * La condition est rendue telle qu'elle a été écrite : c'est elle qu'on relit
 * pour savoir si le seuil était bien placé, et la reformuler la rendrait
 * méconnaissable.
 */

export interface DatabaseNotice {
    /** Le nom de la base dans l'espace. */
    database: string;
    /** L'intitulé de l'alerte. */
    alert: string;
    /** `true` au déclenchement, `false` au retour à la normale. */
    firing: boolean;
    /** Le message rendu, conditions et valeurs substituées. */
    message: string;
    at: number;
}

export function buildNotice(notice: DatabaseNotice): NonNullable<DiscordMessage['embeds']> {
    const fields: Record<string, unknown>[] = [
        { name: '🗄️ Base', value: trim(notice.database), inline: true },
        { name: '📐 Alerte', value: trim(notice.alert), inline: true },
        { name: '📅 Constaté', value: moment(notice.at), inline: true }
    ];
    if (notice.message.trim()) {
        fields.push({ name: notice.firing ? '📊 Ce qui a été mesuré' : '📊 Détail', value: block(notice.message) });
    }

    return [
        {
            title: notice.firing ? `🔴 ${trim(notice.alert)}` : `🟢 ${trim(notice.alert)} — rentré dans l’ordre`,
            description: notice.firing
                ? `Un seuil est franchi sur **${trim(notice.database)}**.`
                : `La base **${trim(notice.database)}** est repassée sous son seuil.`,
            color: notice.firing ? COLOR_DANGER : COLOR_SUCCESS,
            fields,
            timestamp: new Date(notice.at * 1000).toISOString(),
            footer: footer('supervision des bases')
        }
    ];
}
