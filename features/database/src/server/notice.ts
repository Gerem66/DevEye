// Les helpers Discord restent à l'app, partagés par tous ses émetteurs : le
// module les importe plutôt que de les recopier.
import { COLOR_DANGER, COLOR_SUCCESS, block, footer, moment, trim } from '@/Services/notices/shared';

/**
 * L'alerte telle que Discord la montre : déclenchée, puis revenue à la normale
 * (les deux sens sont émis). Rend les embeds seuls ; l'envoi passe par la
 * façade `notify` du SDK.
 */

export interface DatabaseNotice {
    database: string;
    alert: string;
    /** `true` au déclenchement, `false` au retour à la normale. */
    firing: boolean;
    /** Le message rendu, conditions et valeurs substituées. */
    message: string;
    at: number;
}

export function buildNotice(notice: DatabaseNotice): Record<string, unknown>[] {
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
