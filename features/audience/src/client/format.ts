import type {
    AudienceDimension,
    AudienceEventsQuota,
    AudienceFieldKind,
    AudienceFieldValue,
    AudienceFormField,
    AudiencePlatform,
    AudienceRange,
    AudienceResolution,
    AudienceSite,
    AudienceVisitorMode
} from '../contracts/domain';

/** Les fenêtres, dans l'ordre où on les parcourt : du plus près au plus loin. */
export const RANGE_LABELS: Record<AudienceRange, string> = {
    '24h': '24 h',
    '7d': '7 jours',
    '30d': '30 jours',
    '90d': '90 jours',
    '365d': '1 an'
};

export const RANGES: AudienceRange[] = ['24h', '7d', '30d', '90d', '365d'];

/**
 * Le nom d'un axe au pluriel : ce sont des titres de panneaux, et un panneau
 * de classement contient toujours plusieurs lignes.
 */
export const DIMENSION_LABELS: Record<AudienceDimension, string> = {
    path: 'Pages',
    referrer: 'Provenances',
    browser: 'Navigateurs',
    os: 'Systèmes',
    device: 'Appareils',
    timezone: 'Fuseaux',
    language: 'Langues',
    event: 'Événements',
    identity: 'Utilisateurs'
};

/**
 * Ce qu'un panneau dit quand il n'a rien à montrer. Un texte par axe plutôt
 * qu'un « Aucune donnée » générique : le vide y a souvent une cause qu'on peut
 * nommer, ce qui évite de chercher une panne là où il n'y en a pas.
 */
export const DIMENSION_EMPTY: Record<AudienceDimension, string> = {
    path: 'Aucune page vue sur cette période.',
    referrer: 'Aucune provenance externe : les visiteurs arrivent en direct.',
    browser: 'Aucune visite sur cette période.',
    os: 'Aucune visite sur cette période.',
    device: 'Aucune visite sur cette période.',
    timezone: 'Aucun fuseau déclaré.',
    language: 'Aucune langue déclarée.',
    event: 'Aucun événement nommé. Le bouton « Installer » explique comment en poser depuis votre site.',
    identity: 'Aucun utilisateur identifié. Le bouton « Installer » explique comment votre site peut les nommer.'
};

/** Ce qu'un type de question veut dire pour celui qui déclare le formulaire. */
export const FIELD_KIND_LABELS: Record<AudienceFieldKind, string> = {
    text: 'Texte',
    email: 'Adresse e-mail',
    number: 'Nombre',
    boolean: 'Oui / non',
    choice: 'Choix'
};

export const PLATFORM_LABELS: Record<AudiencePlatform, string> = {
    web: 'Site web',
    app: 'Application native',
    both: 'Web et application'
};

/**
 * Ce que la plateforme change, dit à l'endroit où on la choisit : elle décide
 * si les origines autorisées sont appliquées, et se tromper laisse soit une
 * porte ouverte, soit une application qui n'arrive pas à écrire.
 */
export const PLATFORM_HINTS: Record<AudiencePlatform, string> = {
    web: 'Les origines autorisées sont vérifiées à chaque mesure.',
    app: 'Les origines ne sont pas vérifiées : un client natif n’en envoie pas.',
    both: 'Les origines sont vérifiées quand le client en envoie une.'
};

export const VISITOR_LABELS: Record<AudienceVisitorMode, string> = {
    anonymous: 'Anonyme, sans stockage',
    persistent: 'Persistante, identifiant conservé'
};

/**
 * Ce que le mode change, dit là où on le choisit : le second crée une
 * obligation légale pour le site suivi.
 */
export function visitorHint(mode: AudienceVisitorMode, platform: AudiencePlatform): string {
    if (mode === 'anonymous') {
        return (
            'Rien n’est écrit chez le visiteur, donc rien à faire accepter. En contrepartie, une même ' +
            'personne revenant le lendemain compte pour une nouvelle.'
        );
    }
    const how =
        platform === 'web'
            ? 'Ajoutez data-visitor="persistent" à la balise.'
            : platform === 'app'
              ? 'Votre application envoie un visitorId stable avec chaque lot.'
              : 'Ajoutez data-visitor="persistent" à la balise, ou envoyez un visitorId stable depuis l’application.';
    return (
        `${how} Les visiteurs connus et le nombre de visites par personne deviennent mesurables. ` +
        '⚠️ Un identifiant durable relève du consentement, localStorage comme cookie : c’est à votre ' +
        'site de le recueillir.'
    );
}

/**
 * Ce qu'est un « visiteur » sur ce site, dit au survol de la tuile. La
 * définition change avec le réglage : en anonyme, personne n'est reconnu le
 * lendemain ; en persistant, c'est l'identifiant conservé qui fait la personne.
 */
export function visitorsDefinition(mode: AudienceVisitorMode, platform: AudiencePlatform): string {
    if (mode === 'anonymous') {
        return (
            'Personnes distinctes, reconnues sans cookie. Un même visiteur qui revient le lendemain ' +
            'compte pour un nouveau.'
        );
    }
    const keeper =
        platform === 'web' ? 'le navigateur' : platform === 'app' ? 'l’application' : 'le navigateur ou l’application';
    return (
        `Personnes distinctes, reconnues d’une visite à l’autre par l’identifiant que ${keeper} conserve. ` +
        'Un visiteur qui revient reste le même, tant que cet identifiant n’a pas été effacé.'
    );
}

/**
 * Ce que compte le premier nombre d'une ligne de classement, et le second : la
 * même colonne ne dit pas la même chose selon l'axe, et « 312 vis. » seul ne
 * dit pas s'il s'agit de visites ou de visiteurs.
 */
export const DIMENSION_UNITS: Record<AudienceDimension, string> = {
    path: 'vues de cette page',
    referrer: 'pages vues par les visites venues de là',
    browser: 'pages vues avec ce navigateur',
    os: 'pages vues sous ce système',
    device: 'pages vues sur ce type d’appareil',
    timezone: 'pages vues depuis ce fuseau',
    language: 'pages vues dans cette langue',
    event: 'déclenchements de cet événement',
    identity: 'pages vues par cet utilisateur'
};

/** Le sens des deux nombres d'un classement, porté par son titre. */
export const DIMENSION_HINTS: Record<AudienceDimension, string> = {
    path: 'Classées par vues. À droite, le nombre de visiteurs distincts qui l’ont vue.',
    referrer: 'Par pages vues des visites venues de là. À droite, les visiteurs distincts.',
    browser: 'Par pages vues. À droite, les visiteurs distincts.',
    os: 'Par pages vues. À droite, les visiteurs distincts.',
    device: 'Par pages vues. À droite, les visiteurs distincts.',
    timezone: 'Par pages vues. À droite, les visiteurs distincts.',
    language: 'Par pages vues. À droite, les visiteurs distincts.',
    event: 'Par déclenchements. À droite, les visiteurs distincts qui l’ont déclenché.',
    identity: 'Par pages vues. À droite, le nombre de visiteurs distincts sous cette identité.'
};

/** « 1 284 vues de cette page · 312 visiteurs distincts » : le survol d'une ligne. */
export function rowTitle(dimension: AudienceDimension, views: number, visitors: number): string {
    const people = visitors > 1 ? 'visiteurs distincts' : 'visiteur distinct';
    return `${formatCount(views)} ${DIMENSION_UNITS[dimension]} · ${formatCount(visitors)} ${people}`;
}

/**
 * Ce qu'un type accepte, et ce qu'il en fait. Écrit du point de vue de celui
 * qui branche le site, pas de celui qui a écrit le validateur : ce sont les
 * valeurs qu'on peut envoyer, et la valeur rangée qui en sort.
 *
 * La deuxième colonne est la moitié qu'on oublie : un `<form>` HTML n'envoie
 * que des chaînes, et c'est le type déclaré qui les ramène à une valeur. Sans
 * elle, on ne comprend pas pourquoi « 4 » et 4 comptent pour la même réponse.
 */
export const FIELD_FORMAT_HELP: Record<AudienceFieldKind, { accepts: string; stored: string }> = {
    text: {
        accepts: 'N’importe quel texte, jusqu’à 4 096 caractères.',
        stored: 'Rangé tel quel, espaces de début et de fin ôtés.'
    },
    email: {
        accepts: 'Une adresse plausible : « ada@exemple.fr ». Un texte sans @ ni domaine fait refuser l’envoi.',
        stored: 'Rangée en minuscules, pour que deux graphies comptent pour une.'
    },
    number: {
        accepts: 'Un nombre, ou son écriture : 4, "4", "4,5" ou "4.5". La virgule décimale passe.',
        stored: 'Un nombre. « 4 » et 4 tombent donc sur la même ligne de répartition.'
    },
    boolean: {
        accepts: 'true / false, ou "on" : ce qu’envoie une case cochée. Une case décochée n’envoie rien du tout.',
        stored: 'Un booléen. Une case décochée compte comme « non », pas comme une absence de réponse.'
    },
    choice: {
        accepts: 'Une des réponses déclarées, à l’identique. Toute autre valeur fait refuser l’envoi.',
        stored: 'La réponse choisie ; un tableau quand plusieurs réponses sont permises.'
    }
};

/** Comment une question se remplit dans un envoi JSON, à titre d'exemple. */
export function fieldExampleValue(field: AudienceFormField): string {
    if (field.kind === 'email') return '"ada@exemple.fr"';
    if (field.kind === 'number') return '4';
    if (field.kind === 'boolean') return 'true';
    if (field.kind === 'choice') {
        const first = field.choices[0] ?? '';
        return field.multiple ? JSON.stringify(field.choices.slice(0, 2)) : JSON.stringify(first);
    }
    return '"Bonjour"';
}

/** « 1 284 » : un nombre de vues se lit par tranches de mille. */
export function formatCount(value: number): string {
    return value.toLocaleString('fr-FR');
}

/** « 2 min 40 s » : une durée de visite, pas un chronomètre. */
export function formatDuration(seconds: number): string {
    const total = Math.round(seconds);
    if (total < 60) return `${total} s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) {
        const rest = total % 60;
        return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
    }
    const hours = Math.floor(minutes / 60);
    return `${hours} h ${minutes % 60} min`;
}

/** « 38 % » : un taux se lit entier, la décimale n'apprend rien ici. */
export function formatPercent(ratio: number): string {
    return `${Math.round(ratio * 100)} %`;
}

/**
 * L'écart d'une mesure à la période précédente.
 *
 * `null` quand la période précédente est à zéro : « +∞ % » ou « +100 % » sur
 * un site qui démarre serait une information inventée. On préfère ne rien dire.
 */
export function delta(current: number, previous: number): number | null {
    if (previous === 0) return null;
    return (current - previous) / previous;
}

/** « +18 % », « −4 % », avec le vrai signe moins et non un trait d'union. */
export function formatDelta(value: number): string {
    const percent = Math.round(value * 100);
    if (percent === 0) return '±0 %';
    return percent > 0 ? `+${percent} %` : `−${Math.abs(percent)} %`;
}

/**
 * L'étiquette d'un point de la courbe, selon le pas.
 *
 * L'heure seule sur une journée, le jour et le mois au-delà : répéter l'année
 * sur cinquante-deux colonnes ne laisserait de place pour rien d'autre.
 */
export function formatPointLabel(at: number, resolution: AudienceResolution): string {
    const date = new Date(at * 1000);
    if (resolution === 'hour') {
        return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

/** Le titre complet d'un point, celui qu'on lit au survol. */
export function formatPointTitle(at: number, resolution: AudienceResolution): string {
    const date = new Date(at * 1000);
    if (resolution === 'hour') {
        return date.toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit' });
    }
    if (resolution === 'week') {
        return `semaine du ${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
    }
    return date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** « il y a 4 min » : la fraîcheur d'une mesure, pas sa date exacte. */
export function formatAgo(epochSeconds: number | null): string {
    if (epochSeconds === null) return 'aucune mesure';
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
    if (seconds < 60) return 'à l’instant';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return `il y a ${Math.floor(hours / 24)} j`;
}

/**
 * Les abandons d'un entonnoir, et celui qui coûte le plus. `drops[i]` est la
 * part perdue en arrivant sur la marche `i`, rapportée à la précédente ; `null`
 * sur la première, et quand la marche d'avant est à zéro faute de dénominateur.
 *
 * `worst` désigne une seule marche, la première à égalité, et vaut `-1` quand
 * il n'y a rien à désigner (aucune visite, ou personne n'abandonne).
 */
export function funnelDrops(sessions: readonly number[]): { drops: (number | null)[]; worst: number } {
    const drops = sessions.map((count, i) => {
        if (i === 0) return null;
        const before = sessions[i - 1];
        if (before === 0) return null;
        return (before - count) / before;
    });

    let worst = -1;
    let worstDrop = 0;
    drops.forEach((drop, i) => {
        if (drop !== null && drop > worstDrop) {
            worstDrop = drop;
            worst = i;
        }
    });
    return { drops, worst };
}

/** Une part de la barre compacte : des abandons, puis ce qui est arrivé au bout. */
export interface FunnelSegment {
    kind: 'lost' | 'done';
    /** Part de l'entrée, entre 0 et 1. Les parts somment à 1. */
    share: number;
    /** La marche concernée : celle qu'on n'a pas franchie, ou la dernière. */
    step: number;
    /** L'abandon le plus coûteux, celui que la barre met en avant. */
    worst: boolean;
}

/**
 * Un entonnoir ramené à une seule barre : le tout vaut les visites entrées,
 * chaque part est ce qui s'est perdu en chemin et la dernière ce qui est arrivé
 * au bout. Les parts sommant à 1, la barre se lit sans comparer des hauteurs.
 *
 * Vide quand personne n'est entré : dessiner une barre pleine de zéros
 * laisserait croire à une mesure.
 */
export function funnelSegments(sessions: readonly number[]): FunnelSegment[] {
    const entered = sessions[0] ?? 0;
    if (entered <= 0 || sessions.length < 2) return [];

    const { worst } = funnelDrops(sessions);
    const segments: FunnelSegment[] = [];

    for (let i = 0; i < sessions.length - 1; i++) {
        // `max(0)` : la règle ordonnée interdit qu'une marche remonte, mais une part
        // négative déformerait toute la barre si cela arrivait un jour.
        const lost = Math.max(0, sessions[i] - sessions[i + 1]);
        if (lost > 0) segments.push({ kind: 'lost', share: lost / entered, step: i, worst: i + 1 === worst });
    }

    const done = Math.max(0, sessions[sessions.length - 1]);
    if (done > 0) {
        segments.push({ kind: 'done', share: done / entered, step: sessions.length - 1, worst: false });
    }
    return segments;
}

/** Lundi en tête : la semaine à l'européenne, comme partout dans l'interface. */
export const DAY_LABELS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

/**
 * La balise à coller dans une page. `origin` vient du serveur et jamais du
 * navigateur, les deux adresses différant par construction.
 *
 * `data-visitor` n'apparaît que si le site est réglé en persistant : les deux
 * côtés doivent être d'accord, et une balise sans l'attribut laisserait croire
 * que les visiteurs connus se mesurent alors que rien ne serait posé.
 */
export function snippetFor(publicKey: string, origin: string, persistent = false): string {
    const visitor = persistent ? ' data-visitor="persistent"' : '';
    return `<script defer data-key="${publicKey}"${visitor} src="${origin}/t.js"></script>`;
}

/**
 * Une réponse rendue lisible dans une cellule de tableau. Un choix multiple se
 * joint par des virgules plutôt que de garder ses crochets : c'est une liste de
 * cases cochées, pas un tableau JSON, et le brut reste consultable à côté.
 */
export function formatFieldValue(value: AudienceFieldValue): string {
    if (value === null) return '';
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'boolean') return value ? 'oui' : 'non';
    return String(value);
}

/** « 12 mars 2026, 14:32 » : la date exacte d'un retour, pas sa fraîcheur. */
export function formatDateTime(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toLocaleString('fr-FR', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Le `<form>` à coller dans une page, engendré depuis les questions déclarées :
 * c'est tout l'intérêt de les avoir typées. Un champ `email` sort en
 * `type="email"`, un choix en `<select>` garni, une question requise porte
 * `required`, et le formulaire collé correspond alors exactement à ce que le
 * serveur acceptera.
 *
 * `_next` est relatif : le serveur ne renvoie que sur l'origine d'où vient
 * l'envoi, une adresse complète vers ailleurs serait refusée. Le champ `_hp`
 * est un pot de miel, caché aux yeux et rempli par les robots.
 */
export function formSnippetFor(
    publicKey: string,
    origin: string,
    form: string,
    fields: readonly AudienceFormField[]
): string {
    const lines = [
        `<form method="post" action="${origin}/api/t/s">`,
        `    <input type="hidden" name="_key" value="${publicKey}">`,
        `    <input type="hidden" name="_form" value="${form}">`,
        '    <input type="hidden" name="_next" value="/merci.html">',
        '    <input type="text" name="_hp" tabindex="-1" autocomplete="off" hidden>',
        ''
    ];
    for (const field of fields) lines.push(...fieldMarkup(field));
    if (fields.length === 0) {
        // Un formulaire en champs libres n'a rien à engendrer : on montre la forme,
        // pas un contenu qu'on ne connaît pas.
        lines.push('    <!-- Champs libres : nommez vos entrées comme vous voulez. -->');
        lines.push('    <input name="email" type="email" placeholder="Votre adresse">');
        lines.push('    <textarea name="message" placeholder="Votre message"></textarea>');
        lines.push('');
    }
    lines.push('    <button type="submit">Envoyer</button>', '</form>');
    return lines.join('\n');
}

/** Les lignes d'une question, `<label>` compris : c'est ce qu'on colle tel quel. */
function fieldMarkup(field: AudienceFormField): string[] {
    const required = field.required ? ' required' : '';
    const label = `    <label for="f-${field.name}">${field.name}</label>`;

    if (field.kind === 'choice') {
        const multiple = field.multiple ? ' multiple' : '';
        return [
            label,
            `    <select id="f-${field.name}" name="${field.name}"${multiple}${required}>`,
            ...(field.required || field.multiple ? [] : ['        <option value=""></option>']),
            ...field.choices.map((choice) => `        <option>${choice}</option>`),
            '    </select>',
            ''
        ];
    }
    if (field.kind === 'boolean') {
        // Une case décochée n'envoie rien du tout : c'est le type déclaré qui le
        // ramène à « non » côté serveur, et pas le formulaire qui doit y penser.
        return [label, `    <input id="f-${field.name}" type="checkbox" name="${field.name}"${required}>`, ''];
    }
    const type = field.kind === 'email' ? 'email' : field.kind === 'number' ? 'number' : 'text';
    return [label, `    <input id="f-${field.name}" type="${type}" name="${field.name}"${required}>`, ''];
}

/** Le même envoi depuis la balise, quand la page a déjà du JavaScript. */
export function submitSnippetFor(form: string): string {
    return [
        "document.querySelector('form').addEventListener('submit', async (e) => {",
        '    e.preventDefault();',
        '    const data = Object.fromEntries(new FormData(e.target));',
        `    const sent = await window.deveye?.submit('${form}', data);`,
        '    if (sent) e.target.reset();',
        '});'
    ].join('\n');
}

export interface SiteStatus {
    label: string;
    tone: 'neutral' | 'online' | 'warning' | 'danger';
}

/** Les vues du mois ont atteint ce que permet l'offre du propriétaire de l'espace : plus rien n'est mesuré. */
export const quotaReached = (quota: AudienceEventsQuota | null): boolean => quota !== null && quota.used >= quota.limit;

/**
 * Cinq états, un seul alarmant : « en attente » est l'état normal d'un site
 * qu'on vient de déclarer, et le peindre en rouge ferait passer une
 * installation en cours pour un incident. La limite de l'offre ne dit rien d'un
 * site partagé ici : c'est celle de son propre espace qui le borne.
 */
export function siteStatus(site: AudienceSite, quota: AudienceEventsQuota | null): SiteStatus {
    if (!site.active) return { label: 'éteint', tone: 'danger' };
    // Tenu en pause par l'offre, dont la pastille dit pourquoi : rien n'entre.
    if (site.planPaused) return { label: 'en pause', tone: 'warning' };
    if (quotaReached(quota) && !site.foreign) return { label: 'limite atteinte', tone: 'warning' };
    if (site.lastEventAt === null) return { label: 'en attente', tone: 'neutral' };
    return { label: 'actif', tone: 'online' };
}
