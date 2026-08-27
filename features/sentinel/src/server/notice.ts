// Privilège de native rapatriée, commenté à chaque usage : les helpers Discord
// (`moment`, `block`, `trim`, `footer`, la charte des couleurs) sont réellement
// partagés par les cinq émetteurs de l'app, et deux copies avaient déjà divergé
// une fois (voir l'en-tête de `Services/notices/shared.ts`). Ils restent donc à
// l'app, et le module les importe plutôt que de les recopier.
import { COLOR_DANGER, COLOR_INFO, COLOR_WARNING, block, footer, moment, trim } from '@/Services/notices/shared';

/**
 * Le constat de Sentinelle tel que Discord doit le montrer.
 *
 * Sentinelle envoyait du texte brut là où Uptime et Déploiement avaient déjà
 * leur mise en page. L'écart n'était pas un choix : c'est simplement le module
 * qui n'avait jamais été écrit. Or c'est l'émetteur où la lecture en diagonale
 * compte le plus, un salon de sécurité reçoit peu de messages, et chacun doit
 * dire sa gravité **avant** d'être lu.
 *
 * Comme ses voisins : aucune base, aucun réseau, aucun chiffrement. Un état
 * entre, un objet Discord sort, et toute la mise en forme tient à un endroit.
 *
 * Rend le tableau d'embeds plutôt qu'un message Discord entier : le module ne
 * publie pas lui-même, il confie l'envoi à la façade `notify` du SDK
 * (`SdkAlert.embeds`), derrière laquelle `deliver` garde la main sur `content`
 * pour les canaux qui ne connaissent pas les embeds.
 */

/** Ce qu'un constat peut annoncer. */
export interface SentinelNotice {
    /** L'appareil concerné, tel qu'il est nommé dans l'espace. */
    device: string;
    /** L'intitulé de la règle enfreinte. */
    rule: string;
    severity: 'critical' | 'high' | 'low';
    /** Ce que la règle a vu. */
    detail: string;
    /** La remédiation proposée, quand la règle en porte une. */
    remediation: string | null;
    at: number;
}

/**
 * La gravité gouverne la bordure **et** la pastille du titre.
 *
 * Les deux, et pas seulement l'une : la couleur seule ne se lit pas en
 * notification poussée sur téléphone, où l'aplat de bordure disparaît. La
 * pastille, elle, voyage avec le texte.
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

    // Le détail en bloc de code : il vient d'une sonde et porte des chemins, des
    // sommes de contrôle, parfois une ligne de commande entière, autant de
    // caractères que le Markdown mangerait.
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
