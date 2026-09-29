// Helpers Discord partagés par tous les émetteurs de l'app : importés, pas recopiés.
import { COLOR_DANGER, COLOR_SUCCESS, COLOR_WARNING, block, duration, moment, trim } from '@/Services/notices/shared';

/**
 * L'avis de disponibilité tel que Discord doit le montrer : un état devient un
 * embed, sans base, réseau ni chiffrement. Le corps en clair continue de partir
 * par mail, Slack et webhook générique ; `deliver` ne remplace `content` par les
 * embeds que pour un webhook Discord (voir `Services/alertCore.ts`).
 */

/** Ce qu'un avis de disponibilité peut annoncer. */
export type UptimeNotice =
    | {
          event: 'down';
          service: string;
          url: string;
          /** L'instant où la panne a été constatée. */
          at: number;
          error: string | null;
          httpStatus: number | null;
      }
    | {
          event: 'recovered';
          service: string;
          url: string;
          /** L'instant du rétablissement. */
          at: number;
          /** L'ouverture de l'incident, pour en donner la durée. */
          startedAt: number;
          /** L'erreur qui avait ouvert l'incident. */
          cause: string | null;
          responseMs: number | null;
      }
    | {
          event: 'integrity';
          service: string;
          url: string;
          /** L'instant où l'écart a été constaté. */
          at: number;
          /** Le détail, fichier par fichier, déjà borné. */
          lines: string[];
      };

/**
 * L'adresse en lien cliquable, libellée par l'hôte (une URL à rallonge casserait
 * la ligne des trois cases sur téléphone). Une parenthèse ou une espace fermerait
 * le lien Markdown au mauvais endroit : ces adresses-là sont montrées en code.
 */
function address(url: string): string {
    if (!url.trim()) return '—';
    let label = url;
    try {
        label = new URL(url).host || url;
    } catch {
        // Adresse illisible : montrée brute, c'est aussi une information.
    }
    if (/[()\s]/.test(url)) return `\`${trim(url)}\``;
    return `[${trim(label)}](${url})`;
}

function response(httpStatus: number | null): string {
    return httpStatus === null ? 'Aucune réponse' : `Statut ${httpStatus}`;
}

/**
 * Le tableau d'embeds, pas un message entier : l'envoi passe par la façade
 * `notify` du SDK (`SdkAlert.embeds`), qui garde `content` pour les canaux sans
 * embeds.
 */
export function buildNotice(notice: UptimeNotice): Record<string, unknown>[] {
    return [
        {
            ...headline(notice),
            fields: fieldsOf(notice),
            footer: { text: 'DevEye · surveillance de disponibilité' },
            // Discord rend l'horodatage du pied dans le fuseau du lecteur.
            timestamp: new Date(notice.at * 1000).toISOString()
        }
    ];
}

/** Titre, couleur et première lecture : ce qui se voit sans dérouler. */
function headline(notice: UptimeNotice): { title: string; description: string; color: number } {
    if (notice.event === 'down') {
        return {
            title: '🔴 Service hors ligne',
            description: `**${trim(notice.service)}** ne répond plus.`,
            color: COLOR_DANGER
        };
    }
    if (notice.event === 'integrity') {
        return {
            title: '🟠 Intégrité : fichiers modifiés',
            description: `Ce que sert **${trim(notice.service)}** n’est plus ce qui avait été accepté.`,
            color: COLOR_WARNING
        };
    }
    return {
        title: '🟢 Service rétabli',
        description: `**${trim(notice.service)}** répond de nouveau.`,
        color: COLOR_SUCCESS
    };
}

/**
 * Trois cases en ligne d'abord (Discord les place côte à côte), puis le détail
 * de l'erreur en dernier : seul élément de longueur inconnue, plus haut il
 * repousserait l'identité du service sous un pavé.
 */
function fieldsOf(notice: UptimeNotice): Record<string, unknown>[] {
    if (notice.event === 'down') {
        return [
            { name: '🌐 Adresse', value: address(notice.url), inline: true },
            { name: '🚦 Réponse', value: response(notice.httpStatus), inline: true },
            // En relatif : le pied porte déjà l'heure exacte, « il y a 40 minutes »
            // dit depuis combien de temps ça dure.
            { name: '📅 Depuis', value: moment(notice.at, 'R'), inline: true },
            { name: '⚠️ Erreur', value: block(notice.error ?? 'inconnue'), inline: false }
        ];
    }
    if (notice.event === 'integrity') {
        return [
            { name: '🌐 Adresse', value: address(notice.url), inline: true },
            { name: '📅 Constaté', value: moment(notice.at, 'R'), inline: true },
            { name: '📄 Écart', value: block(notice.lines.join('\n')), inline: false },
            {
                name: '✅ Déploiement voulu ?',
                value: 'Acceptez la version actuelle depuis la fiche du service.',
                inline: false
            }
        ];
    }

    const fields: Record<string, unknown>[] = [
        { name: '🌐 Adresse', value: address(notice.url), inline: true },
        {
            name: '⏱️ Indisponible',
            value: duration(Math.max(0, notice.at - notice.startedAt)),
            inline: true
        },
        { name: '🚦 Réponse', value: notice.responseMs === null ? '—' : `${notice.responseMs} ms`, inline: true },
        // En relatif : plus vite lu après coup, la durée juste au-dessus donne l'ampleur.
        { name: '📉 Tombé', value: moment(notice.startedAt, 'R'), inline: true },
        { name: '📈 Rétabli', value: moment(notice.at), inline: true }
    ];
    if (notice.cause) fields.push({ name: '🔎 Cause initiale', value: block(notice.cause), inline: false });
    return fields;
}
