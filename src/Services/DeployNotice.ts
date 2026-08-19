import type { DeploymentRow } from 'deveye-types';

import type { DiscordMessage } from '@/Services/discord';

/**
 * Le message de suivi d'un déploiement : ce qu'il montre, et comment il le dit.
 *
 * Séparé du service qui l'envoie parce que ce sont deux métiers : celui-ci ne
 * connaît ni la base ni le réseau, il transforme un état en un objet Discord.
 * C'est aussi ce qui le rend lisible d'un coup d'œil — toute la mise en forme du
 * message est ici, et nulle part ailleurs.
 *
 * ## Le seul point délicat : il n'y a pas de progression à afficher
 *
 * Dokploy n'en publie aucune. La réponse de `deployment.all` a été relevée sur
 * l'instance de référence, champ par champ : `status`, `createdAt`, `startedAt`,
 * `finishedAt`, `errorMessage`, `logPath`, et des identifiants. Rien qui
 * ressemble à un pourcentage ou à une étape.
 *
 * La barre est donc une **estimation**, calculée sur la durée moyenne des dix
 * derniers déploiements réussis de **cette cible** — ce qui n'est possible que
 * depuis que le rapprochement de fond garde l'historique en base (migration
 * 085). Elle est présentée comme telle : le libellé dit « estimé », et quand le
 * temps écoulé dépasse la moyenne la barre reste pleine en annonçant « plus long
 * que d'habitude » plutôt que de laisser croire à une fin imminente. Une barre
 * qui ment est pire qu'une barre absente.
 *
 * Sans historique exploitable — une cible neuve, un premier déploiement — il n'y
 * a pas de barre du tout, seulement le temps écoulé. C'est le cas honnête.
 */

/** Couleurs de la charte Discord : la bordure dit l'issue avant la lecture. */
const COLOR_RUNNING = 0x5865f2;
const COLOR_SUCCESS = 0x57f287;
const COLOR_FAILURE = 0xed4245;

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

/** Discord refuse la valeur d'un champ au-delà de 1024 caractères. */
const FIELD_MAX = 1000;

/**
 * Longueur au-delà de laquelle un intitulé de déploiement est coupé.
 *
 * Le titre vient de Dokploy, qui y met le **message de commit** — donc son sujet
 * *et* son corps. Un commit correctement écrit tient son sujet sous 72
 * caractères ; cent laisse de la marge à ceux qui n'en font qu'à leur tête, sans
 * qu'une seule ligne mange l'écran d'un téléphone.
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
 * La durée moyenne des derniers déploiements **réussis** d'une cible.
 *
 * Les échecs sont écartés, et c'est le point : un échec s'arrête à la première
 * étape qui casse, souvent en quelques secondes. Les mêler à la moyenne ferait
 * chuter l'estimation à chaque build raté, et la barre d'un déploiement sain
 * sauterait à 100 % au bout de dix secondes.
 *
 * `null` quand il n'y a rien à moyenner : l'appelant n'affiche alors pas de
 * barre, plutôt qu'une barre calée sur une valeur inventée.
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
    // `Number.isFinite` d'abord : `Math.min`/`Math.max` **laissent passer NaN**,
    // et `repeat(NaN)` rend une chaîne vide sans lever. La barre disparaissait
    // donc au lieu d'être bornée — exactement le genre de panne qu'un bornage
    // est censé empêcher.
    const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
    const filled = Math.round(clamped * BAR_SEGMENTS);
    return `${'▰'.repeat(filled)}${'▱'.repeat(BAR_SEGMENTS - filled)}`;
}

/**
 * Les séquences ANSI, qu'un bloc de code Discord rendrait telles quelles.
 *
 * Dokploy colore sa sortie de build. Sans ce nettoyage, le journal arrive noyé
 * sous des `[0m` et devient illisible — le contraire de ce qu'on affiche un
 * journal pour obtenir.
 */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * La queue d'un journal, débarrassée de ce qui ne se voit pas dans Discord.
 *
 * Les lignes vides de fin partent aussi, sans quoi le bloc s'ouvrirait sur du
 * vide à chaque rafraîchissement.
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
 * Le sujet d'un message de commit : sa **première ligne**, et rien d'autre.
 *
 * Dokploy range le message de commit entier dans le titre du déploiement. Un
 * commit bavard — sujet, ligne vide, quinze lignes de justification — remplissait
 * donc le haut du message Discord et repoussait tout le reste vers le bas, à
 * chaque rafraîchissement.
 *
 * Le corps n'est pas déplacé ailleurs, il est **abandonné** : Discord n'a aucune
 * infobulle dans un embed (le seul survol possible passe par un lien masqué,
 * ce qui obligerait à transformer l'intitulé en lien, et le lien vers Dokploy
 * existe déjà dans son propre champ). Qui veut le message complet l'ouvre là-bas.
 *
 * Les points de suspension ne sont ajoutés que si la **ligne elle-même** a été
 * coupée : signaler l'existence d'un corps de commit n'apprendrait rien à qui
 * regarde un avis de déploiement.
 */
export function firstLine(text: string, max = TITLE_MAX): string {
    const line = text.replace(/\r/g, '').split('\n')[0].trim();
    if (line.length <= max) return line;
    return `${line.slice(0, max - 1).trimEnd()}…`;
}

/** « 2 min 25 », « 45 s » — la même échelle que les corps d'alerte. */
function duration(seconds: number): string {
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
    const hours = Math.floor(minutes / 60);
    return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/**
 * Un instant, rendu par Discord dans le fuseau **du lecteur**.
 *
 * `<t:epoch:f>` plutôt qu'une date que nous formaterions : chacun lit l'heure
 * chez lui, et le message reste juste pour une équipe répartie. `:R` donne le
 * relatif (« il y a 2 minutes »), qui se met à jour tout seul même entre deux
 * modifications du message.
 */
function moment(epochSeconds: number, style: 'f' | 'R' | 'T' = 'f'): string {
    return `<t:${epochSeconds}:${style}>`;
}

function block(body: string): string {
    return `\`\`\`\n${body}\n\`\`\``;
}

/**
 * Le journal, en **champ** et non dans la description.
 *
 * Discord rend toujours les `fields` **après** la `description` : tant que le
 * journal vivait dans la seconde, projet, service et durée se retrouvaient
 * dessous, c'est-à-dire loin du titre et séparés de lui par dix lignes de build.
 * Le déplacer est le seul moyen de les faire remonter — l'ordre des deux blocs
 * n'est pas réglable.
 *
 * D'où le budget : la valeur d'un champ est plafonnée par Discord (1024
 * caractères) là où une description en accepte 4096. On retire donc des lignes
 * **par le haut** — les plus anciennes, les moins utiles — jusqu'à tenir, plutôt
 * que de laisser Discord rejeter le message entier.
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
 * Le message, dans l'état où il doit être vu maintenant.
 *
 * **Une seule fonction pour les trois états**, et c'est délibéré : c'est le même
 * message qui est modifié du début à la fin, donc le lecteur doit y retrouver
 * les mêmes repères aux mêmes places. Trois constructeurs séparés auraient
 * dérivé, et l'on aurait vu des champs se déplacer au moment de la conclusion.
 */
export function buildNotice(state: NoticeState): DiscordMessage {
    const running = state.status === 'queued' || state.status === 'running';
    const failed = state.status === 'failed';
    const elapsed = Math.max(0, (state.finishedAt ?? state.now) - state.startedAt);

    // Trois par ligne : c'est ce que Discord place côte à côte, et c'est le
    // rythme des avis de Dokploy — projet, service, environnement d'abord, ce
    // qui répond à « où ? » avant de répondre à « quand ? ».
    const fields: Record<string, unknown>[] = [
        { name: '🛠️ Projet', value: trim(state.project ?? '—'), inline: true },
        { name: '⚙️ Service', value: trim(state.service), inline: true },
        { name: '🌍 Environnement', value: trim(state.environment ?? '—'), inline: true },
        { name: '📦 Type', value: state.kind === 'compose' ? 'compose' : 'application', inline: true },
        { name: '📅 Démarré', value: moment(state.startedAt, 'f'), inline: true }
    ];

    // La troisième colonne de la seconde ligne dit le temps — écoulé tant que ça
    // tourne, total une fois conclu. Le même emplacement dans les deux états :
    // c'est le même message qui se transforme, l'œil ne doit pas avoir à le
    // rechercher au moment de la conclusion.
    fields.push(
        running
            ? { name: '⏳ Écoulé', value: duration(elapsed), inline: true }
            : { name: '⏱️ Durée', value: duration(elapsed), inline: true }
    );

    // Le journal **après** les six cases d'identité et de temps, et le lien
    // après lui : on lit « quoi, où, combien de temps » avant d'entrer dans la
    // sortie de build.
    const tail = logField(state.log);
    if (tail) fields.push({ name: '📄 Journal', value: tail, inline: false });

    if (state.url) {
        fields.push({ name: '🔗 Dokploy', value: `[Ouvrir la fiche du service](${state.url})`, inline: false });
    }

    // La description ne garde que ce qui doit être lu **avant** tout le reste :
    // le titre, l'avancement, et la raison d'un échec.
    const parts: string[] = [`**${firstLine(state.title) || 'Déploiement'}**`];
    if (running) parts.push(progressLine(state, elapsed));
    if (failed && state.error) parts.push(`⚠️ ${state.error.slice(0, FIELD_MAX)}`);

    return {
        embeds: [
            {
                title: running ? '🚀 Déploiement en cours' : failed ? '❌ Déploiement échoué' : '✅ Déploiement réussi',
                description: parts.join('\n\n').slice(0, DESCRIPTION_MAX),
                color: running ? COLOR_RUNNING : failed ? COLOR_FAILURE : COLOR_SUCCESS,
                fields,
                footer: { text: 'DevEye · suivi de déploiement' },
                // L'horodatage du pied : Discord le rend dans le fuseau du
                // lecteur, et il marque l'instant du **dernier** état connu —
                // donc il avance à chaque modification, ce qui donne à voir que
                // le message est vivant.
                timestamp: new Date((state.finishedAt ?? state.now) * 1000).toISOString()
            }
        ]
    };
}

/** Discord refuse une valeur de champ vide : un tiret vaut mieux qu'un rejet. */
function trim(value: string): string {
    const clean = value.trim().slice(0, FIELD_MAX);
    return clean.length > 0 ? clean : '—';
}

/**
 * La ligne de barre, ou le simple temps écoulé quand rien ne permet d'estimer.
 *
 * Le dépassement est **dit**, pas masqué : passé la moyenne, la barre reste
 * pleine et le texte annonce « plus long que d'habitude ». Laisser un « 100 % »
 * nu sur un déploiement qui continue serait exactement le mensonge qu'on veut
 * éviter — le lecteur croirait à une fin, et se demanderait pourquoi le message
 * ne conclut pas.
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
