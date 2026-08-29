// Helpers Discord partagés par tous les émetteurs de l'app : importés, pas recopiés.
import { COLOR_DANGER, COLOR_INFO, COLOR_WARNING, block, footer, moment, trim } from '@/Services/notices/shared';

/**
 * Le constat de sécurité tel que Discord doit le montrer : un état entre, des
 * embeds sortent, sans base, réseau ni chiffrement. Le module ne publie pas
 * lui-même, il confie l'envoi à la façade `notify` du SDK (`SdkAlert.embeds`),
 * derrière laquelle `deliver` garde la main sur `content` pour les canaux qui
 * ne connaissent pas les embeds.
 */

/** Ce qu'un constat peut annoncer. */
export interface SentinelNotice {
    device: string;
    rule: string;
    severity: 'critical' | 'high' | 'low';
    /** Ce que la règle a vu. */
    detail: string;
    remediation: string | null;
    at: number;
}

/**
 * La gravité gouverne la bordure et la pastille du titre, pas seulement l'une :
 * l'aplat de bordure disparaît en notification poussée sur téléphone, la
 * pastille voyage avec le texte.
 */
const SEVERITY: Record<SentinelNotice['severity'], { color: number; badge: string; label: string }> = {
    critical: { color: COLOR_DANGER, badge: '🔴', label: 'Critique' },
    high: { color: COLOR_WARNING, badge: '🟠', label: 'Élevé' },
    low: { color: COLOR_INFO, badge: '🔵', label: 'À surveiller' }
};

export function buildNotice(notice: SentinelNotice): Record<string, unknown>[] {
    const severity = SEVERITY[notice.severity];
    const fields: Record<string, unknown>[] = [
        { name: '🖥️ Appareil', value: trim(notice.device), inline: true },
        { name: '⚖️ Gravité', value: severity.label, inline: true },
        { name: '📅 Constaté', value: moment(notice.at), inline: true }
    ];

    // Le détail en bloc de code : chemins, sommes de contrôle, lignes de commande,
    // autant de caractères que le Markdown mangerait.
    if (notice.detail.trim()) fields.push({ name: '🔎 Ce qui a été vu', value: block(notice.detail) });
    if (notice.remediation?.trim()) fields.push({ name: '🛠️ Que faire', value: trim(notice.remediation) });

    return [
        {
            title: `${severity.badge} ${trim(notice.rule)}`,
            description: `Un constat de sécurité sur **${trim(notice.device)}**.`,
            color: severity.color,
            fields,
            timestamp: new Date(notice.at * 1000).toISOString(),
            footer: footer('sentinelle')
        }
    ];
}
