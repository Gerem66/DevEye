import type { DeploymentRow } from '../contracts/domain';
import type { SdkRichMessage } from '@deveye/types/sdk/server';

// Les helpers Discord sont partagés avec les émetteurs de l'app : importés
// plutôt que recopiés, deux copies ayant déjà divergé une fois.
import {
    COLOR_DANGER,
    COLOR_INFO,
    COLOR_SUCCESS,
    FIELD_MAX,
    block,
    duration,
    moment,
    trim
} from '@/Services/notices/shared';

/**
 * Le message de suivi d'un déploiement : transforme un état en objet Discord,
 * sans base ni réseau.
 *
 * Dokploy ne publie aucune progression (`deployment.all` rend statut, dates,
 * message d'erreur, chemin du journal, rien d'autre). La barre est donc une
 * estimation sur la durée moyenne des derniers déploiements réussis de la
 * cible, présentée comme telle : « estimé », et « plus long que d'habitude »
 * passé la moyenne plutôt qu'un 100 % trompeur. Sans historique, pas de barre.
 */

/** Segments de la barre. Dix : lisible sur mobile, sans passer à la ligne. */
const BAR_SEGMENTS = 10;

/** Déploiements retenus pour l'estimation. */
export const ESTIMATE_SAMPLE = 10;

/** Lignes de journal montrées sous la barre. */
const LOG_LINES = 8;

/** Largeur maximale d'une ligne de journal, pour ne pas casser la mise en page. */
const LOG_LINE_MAX = 110;

/** Discord refuse une description au-delà de 4096 caractères. */
const DESCRIPTION_MAX = 4000;

/**
 * Coupe de l'intitulé : Dokploy y met le message de commit entier. Cent laisse
 * de la marge au-delà des 72 caractères d'un sujet bien écrit, sans manger
 * l'écran d'un téléphone.
 */
const TITLE_MAX = 100;

export interface NoticeState {
    /** Le projet Dokploy (« OxyFoo »). `null` si l'instance n'a pu être lue. */
    project: string | null;
    /** Le service déployé (« server ») — à défaut, le nom de la cible DevEye. */
    service: string;
    /** L'environnement (« production »). */
    environment: string | null;
    kind: 'application' | 'compose';
    /** La fiche dans le tableau de bord Dokploy ; `null` si non reconstructible. */
    url: string | null;
    /** Le titre du déploiement chez le fournisseur (« Manual deployment »…). */
    title: string;
    status: 'queued' | 'running' | 'success' | 'failed';
    startedAt: number;
    finishedAt: number | null;
    /** Le message d'erreur du fournisseur, quand il y en a un. */
    error: string;
    /** La queue du journal, brute. Vide quand elle n'a pas pu être lue. */
    log: string;
    /** Durée moyenne des déploiements passés, en secondes ; `null` si inconnue. */
    estimateSeconds: number | null;
    /** L'instant de rendu — passé en argument pour que le message soit reproductible. */
    now: number;
}

/**
 * La durée moyenne des derniers déploiements réussis d'une cible. Les échecs
 * sont écartés : un échec s'arrête en quelques secondes et ferait chuter
 * l'estimation. `null` quand il n'y a rien à moyenner : pas de barre.
 */
export function estimateFromHistory(rows: DeploymentRow[], excludeId: number): number | null {
    const durations: number[] = [];
    for (const row of rows) {
        if (row.id === excludeId || row.status !== 'success' || row.finished_at === null) continue;
        const seconds = Number(row.finished_at) - Number(row.started_at);
        // Une durée nulle ou négative n'est pas une mesure : elle vient d'un
        // horodatage manquant côté fournisseur, pas d'un déploiement instantané.
        if (seconds > 0) durations.push(seconds);
        if (durations.length >= ESTIMATE_SAMPLE) break;
    }
    if (durations.length === 0) return null;
    return Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length);
}

/** `▰▰▰▰▰▱▱▱▱▱`, borné à [0, 100] % — jamais négatif, jamais au-delà. */
export function progressBar(ratio: number): string {
    // `Number.isFinite` d'abord : `Math.min`/`Math.max` laissent passer NaN, et
    // `repeat(NaN)` rend une chaîne vide sans lever.
    const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
    const filled = Math.round(clamped * BAR_SEGMENTS);
    return `${'▰'.repeat(filled)}${'▱'.repeat(BAR_SEGMENTS - filled)}`;
}

/** Les séquences ANSI de la sortie de build, qu'un bloc de code Discord rendrait telles quelles. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * La queue d'un journal, débarrassée de ce qui ne se voit pas dans Discord. Les
 * lignes vides de fin partent aussi, sans quoi le bloc s'ouvrirait sur du vide.
 */
export function tailOf(log: string, lines = LOG_LINES): string {
    if (!log) return '';
    const clean = log
        .replace(ANSI, '')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => (line.length > LOG_LINE_MAX ? `${line.slice(0, LOG_LINE_MAX)}…` : line));

    while (clean.length > 0 && clean[clean.length - 1].trim() === '') clean.pop();
    return clean.slice(-lines).join('\n').trim();
}

/**
 * Le sujet d'un message de commit : sa première ligne. Dokploy range le message
 * entier dans le titre, et un corps de commit repousserait tout le message. Le
 * corps est abandonné (un embed Discord n'a pas d'infobulle) ; les points de
 * suspension ne signalent qu'une ligne coupée.
 */
export function firstLine(text: string, max = TITLE_MAX): string {
    const line = text.replace(/\r/g, '').split('\n')[0].trim();
    if (line.length <= max) return line;
    return `${line.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Le journal en champ et non dans la description : Discord rend les `fields`
 * après la `description`, et c'est le seul moyen de garder projet, service et
 * durée près du titre. Un champ est plafonné à 1024 caractères : on retire des
 * lignes par le haut jusqu'à tenir.
 */
function logField(log: string): string | null {
    const tail = tailOf(log);
    if (!tail) return null;

    let lines = tail.split('\n');
    while (lines.length > 1 && block(lines.join('\n')).length > FIELD_MAX) lines = lines.slice(1);

    // Une seule ligne encore trop longue : on garde sa fin, où se trouve le
    // message d'erreur d'un compilateur ou d'un `npm` qui a échoué.
    let body = lines.join('\n');
    if (block(body).length > FIELD_MAX) body = `…${body.slice(-(FIELD_MAX - 16))}`;
    return block(body);
}

/**
 * Le message, dans l'état où il doit être vu maintenant. Une seule fonction pour
 * les trois états : c'est le même message qui est modifié du début à la fin, le
 * lecteur doit y retrouver les mêmes repères. Rendu sous la forme que
 * `notify.postLive` prend (`SdkRichMessage`).
 */
export function buildNotice(state: NoticeState): SdkRichMessage {
    const running = state.status === 'queued' || state.status === 'running';
    const failed = state.status === 'failed';
    const elapsed = Math.max(0, (state.finishedAt ?? state.now) - state.startedAt);

    // Trois par ligne, ce que Discord place côte à côte : projet, service,
    // environnement d'abord (« où ? » avant « quand ? »).
    const fields: Record<string, unknown>[] = [
        { name: '🛠️ Projet', value: trim(state.project ?? '—'), inline: true },
        { name: '⚙️ Service', value: trim(state.service), inline: true },
        { name: '🌍 Environnement', value: trim(state.environment ?? '—'), inline: true },
        { name: '📦 Type', value: state.kind === 'compose' ? 'compose' : 'application', inline: true },
        { name: '📅 Démarré', value: moment(state.startedAt, 'f'), inline: true }
    ];

    // Le temps (écoulé tant que ça tourne, total une fois conclu) garde le même
    // emplacement dans les deux états.
    fields.push(
        running
            ? { name: '⏳ Écoulé', value: duration(elapsed), inline: true }
            : { name: '⏱️ Durée', value: duration(elapsed), inline: true }
    );

    // Le journal après les six cases d'identité et de temps, et le lien après
    // lui.
    const tail = logField(state.log);
    if (tail) fields.push({ name: '📄 Journal', value: tail, inline: false });

    if (state.url) {
        fields.push({ name: '🔗 Dokploy', value: `[Ouvrir la fiche du service](${state.url})`, inline: false });
    }

    // La description ne garde que ce qui doit être lu avant tout le reste : le
    // titre, l'avancement, et la raison d'un échec.
    const parts: string[] = [`**${firstLine(state.title) || 'Déploiement'}**`];
    if (running) parts.push(progressLine(state, elapsed));
    if (failed && state.error) parts.push(`⚠️ ${state.error.slice(0, FIELD_MAX)}`);

    return {
        embeds: [
            {
                title: running ? '🚀 Déploiement en cours' : failed ? '❌ Déploiement échoué' : '✅ Déploiement réussi',
                description: parts.join('\n\n').slice(0, DESCRIPTION_MAX),
                color: running ? COLOR_INFO : failed ? COLOR_DANGER : COLOR_SUCCESS,
                fields,
                footer: { text: 'DevEye · suivi de déploiement' },
                // Discord rend l'horodatage du pied dans le fuseau du lecteur ;
                // il avance à chaque modification, ce qui montre que le message
                // est vivant.
                timestamp: new Date((state.finishedAt ?? state.now) * 1000).toISOString()
            }
        ]
    };
}

/**
 * La ligne de barre, ou le simple temps écoulé sans estimation. Passé la
 * moyenne, la barre reste pleine et le texte dit « plus long que d'habitude » :
 * un 100 % nu ferait croire à une fin.
 */
function progressLine(state: NoticeState, elapsed: number): string {
    if (state.estimateSeconds === null || state.estimateSeconds <= 0) {
        return `⏳ ${duration(elapsed)} écoulées — première mise en production de cette cible, aucune durée de référence.`;
    }
    const ratio = elapsed / state.estimateSeconds;
    const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
    const bar = `\`${progressBar(ratio)}\` **${percent} %**`;

    if (ratio >= 1) return `${bar}\nPlus long que d’habitude (moyenne : ${duration(state.estimateSeconds)}).`;
    return `${bar}\n~${duration(Math.max(1, state.estimateSeconds - elapsed))} restantes (estimé).`;
}
