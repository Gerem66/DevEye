// Privilège de native rapatriée, commenté à chaque usage : les helpers Discord
// (`moment`, `block`, `trim`, `footer`, la charte des couleurs) sont réellement
// partagés par les émetteurs de l'app, et deux copies avaient déjà divergé une
// fois (voir l'en-tête de `Services/notices/shared.ts`). Ils restent donc à
// l'app, et le module les importe plutôt que de les recopier.
import { COLOR_DANGER, COLOR_SUCCESS, block, footer, moment, trim } from '@/Services/notices/shared';

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
 *
 * Rend le tableau d'embeds plutôt qu'un message Discord entier : le module ne
 * publie pas lui-même, il confie l'envoi à la façade `notify` du SDK
 * (`SdkAlert.embeds`), derrière laquelle `deliver` garde la main sur `content`
 * pour les canaux qui ne connaissent pas les embeds.
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
