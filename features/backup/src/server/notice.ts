// Les helpers Discord restent à l'app : partagés par tous les émetteurs, et deux
// copies avaient déjà divergé (voir `Services/notices/shared.ts`).
import { COLOR_DANGER, block, footer, moment, trim } from '@/Services/notices/shared';

/**
 * L'avis d'échec de sauvegarde pour Discord. Seuls les échecs sont annoncés :
 * un canal rempli de succès quotidiens noierait celui qui compte. Pas de
 * variante « rétablie » : rien à rétablir.
 */

export interface BackupNotice {
    job: string;
    destination: string | null;
    error: string;
    at: number;
}

export function buildNotice(notice: BackupNotice): Record<string, unknown>[] {
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
