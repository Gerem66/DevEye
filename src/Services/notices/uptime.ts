import type { DiscordMessage } from '@/Services/discord';
import { COLOR_DANGER, COLOR_INFO, COLOR_SUCCESS, block, duration, moment, trim } from './shared';

/**
 * L'avis de disponibilité tel que Discord doit le montrer.
 *
 * Séparé du moniteur pour la même raison que `DeployNotice` l'est du service qui
 * l'envoie : ce module ne connaît ni la base, ni le réseau, ni le chiffrement —
 * il transforme un état en un objet Discord, et toute la mise en forme tient
 * donc à un seul endroit.
 *
 * ## Pourquoi un embed plutôt que le texte qui partait jusqu'ici
 *
 * Uptime envoyait sa charge utile à trois têtes (`content` pour Discord, `text`
 * pour Slack, les champs structurés pour un point d'entrée maison), c'est-à-dire
 * le **corps du mail** recopié tel quel dans un salon : un pavé de six lignes
 * alignées à la main, sans couleur, sans date cliquable, noyé dans le fil. À
 * côté des avis de déploiement, qui viennent souvent du même salon, la
 * différence se voyait à un mètre.
 *
 * L'embed reprend donc les repères de `DeployNotice` — bordure colorée, titre
 * d'état, trois cases en ligne, pied signé, horodatage — pour qu'un lecteur
 * n'ait pas à réapprendre à lire selon la feature qui parle.
 *
 * ## Ce qui reste du texte
 *
 * Tout. Le corps en clair continue de partir par mail, sur Slack et vers un
 * point d'entrée maison : `deliver` ne remplace `content` par les embeds **que**
 * si le webhook est bien celui de Discord (voir `Services/notifications.ts`).
 * Aucun canal ne perd d'information, et l'avis reste lisible là où les embeds
 * n'existent pas.
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
          /** Le temps de réponse de la sonde qui a conclu. */
          responseMs: number | null;
      }
    | { event: 'test'; at: number };

/**
 * L'adresse surveillée, en lien cliquable quand elle s'y prête.
 *
 * Le libellé est l'hôte, pas l'URL entière : une adresse à rallonge (jeton de
 * santé, paramètres de requête) casserait la ligne des trois cases sur
 * téléphone, alors que l'hôte suffit à reconnaître le service.
 *
 * Une parenthèse ou une espace dans l'adresse ferme le lien Markdown au mauvais
 * endroit, et le champ arriverait moitié lien moitié texte : ces adresses-là
 * sont montrées en code, entières, plutôt que joliment cassées.
 */
function address(url: string): string {
    if (!url.trim()) return '—';
    let label = url;
    try {
        label = new URL(url).host || url;
    } catch {
        // Adresse illisible : elle sera montrée brute, ce qui est aussi une
        // information — c'est peut-être elle, la panne.
    }
    if (/[()\s]/.test(url)) return `\`${trim(url)}\``;
    return `[${trim(label)}](${url})`;
}

/** Ce que la sonde a obtenu : un statut, ou rien du tout. */
function response(httpStatus: number | null): string {
    return httpStatus === null ? 'Aucune réponse' : `Statut ${httpStatus}`;
}

/**
 * L'avis, prêt à partir.
 *
 * Rend le tableau d'embeds plutôt qu'un {@link DiscordMessage} entier : Uptime
 * ne publie pas lui-même, il confie l'envoi à `deliver`, qui garde la main sur
 * `content` pour les canaux qui ne connaissent pas les embeds.
 */
export function buildNotice(notice: UptimeNotice): NonNullable<DiscordMessage['embeds']> {
    return [
        {
            ...headline(notice),
            fields: fieldsOf(notice),
            footer: { text: 'DevEye · surveillance de disponibilité' },
            // Discord rend l'horodatage du pied dans le fuseau du lecteur, et le
            // place à côté de la signature : l'avis dit quand il a été émis sans
            // dépenser une case pour le dire.
            timestamp: new Date(notice.at * 1000).toISOString()
        }
    ];
}

/** Titre, couleur et première lecture — ce qui se voit sans dérouler. */
function headline(notice: UptimeNotice): { title: string; description: string; color: number } {
    if (notice.event === 'down') {
        return {
            title: '🔴 Service hors ligne',
            description: `**${trim(notice.service)}** ne répond plus.`,
            color: COLOR_DANGER
        };
    }
    if (notice.event === 'recovered') {
        return {
            title: '🟢 Service rétabli',
            description: `**${trim(notice.service)}** répond de nouveau.`,
            color: COLOR_SUCCESS
        };
    }
    return {
        title: '🔔 Test de notification',
        description: 'Si vous lisez ce message, les alertes de disponibilité vous parviendront bien.',
        color: COLOR_INFO
    };
}

/**
 * Les cases, dans l'ordre où on les lit.
 *
 * Trois en ligne d'abord — c'est ce que Discord place côte à côte —, puis ce qui
 * ne tient pas dans une case. Le détail de l'erreur vient **en dernier** parce
 * qu'il est le seul élément de longueur inconnue : le mettre plus haut
 * repousserait l'identité du service sous un pavé, exactement le défaut qu'on
 * corrige.
 */
function fieldsOf(notice: UptimeNotice): Record<string, unknown>[] {
    if (notice.event === 'test') {
        return [{ name: '📅 Envoyé', value: moment(notice.at), inline: true }];
    }

    if (notice.event === 'down') {
        return [
            { name: '🌐 Adresse', value: address(notice.url), inline: true },
            { name: '🚦 Réponse', value: response(notice.httpStatus), inline: true },
            // En relatif, et pas par coquetterie : le pied du message porte déjà
            // l'heure exacte de l'émission. « il y a 40 minutes » dit ce que
            // celle-ci ne dit pas — depuis combien de temps ça dure — et
            // continue de compter tant que le message reste dans le fil.
            { name: '📅 Depuis', value: moment(notice.at, 'R'), inline: true },
            { name: '⚠️ Erreur', value: block(notice.error ?? 'inconnue'), inline: false }
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
        // La panne est datée en relatif : « il y a 2 heures » se lit plus vite
        // qu'une heure absolue quand on découvre le message après coup, et la
        // durée juste au-dessus donne déjà l'ampleur.
        { name: '📉 Tombé', value: moment(notice.startedAt, 'R'), inline: true },
        { name: '📈 Rétabli', value: moment(notice.at), inline: true }
    ];
    if (notice.cause) fields.push({ name: '🔎 Cause initiale', value: block(notice.cause), inline: false });
    return fields;
}
