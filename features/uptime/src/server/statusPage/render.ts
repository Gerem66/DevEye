import { UPTIME_PAGE_DAYS } from '../../contracts/domain';
import { formatDuration, formatMs, formatRatio } from '../../contracts/format';
import { escapeHtml } from './html';
import { STATUS_STYLE } from './style';
import type {
    BarTone,
    ServiceState,
    StatusBanner,
    StatusBar,
    StatusIncidentView,
    StatusPageView,
    StatusServiceView
} from './view';
import { HISTORY_DAYS, LATENCY_HOURS } from './view';

/**
 * La page de statut, en HTML : un document complet, sans ressource distante,
 * que le script servi à côté relit toutes les minutes (`#status`). Les heures
 * sont écrites en UTC ; le script les remet dans le fuseau du visiteur.
 */

export interface RenderOptions {
    /** Où mène « DevEye » au pied de la page ; vide, pas de lien. */
    siteUrl: string;
    scriptPath: string;
}

const dayFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const momentFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

function moment(epochSeconds: number): string {
    const date = new Date(epochSeconds * 1000);
    return `<time datetime="${date.toISOString()}" data-format="moment">${escapeHtml(momentFormat.format(date))} UTC</time>`;
}

const ICONS: Record<StatusBanner['tone'], string> = {
    up: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    down: '<path d="M12 6.5v7M12 17.5h.01"/>',
    pending: '<circle cx="12" cy="12" r="7.5"/><path d="M12 8v4.5l2.5 2"/>',
    paused: '<path d="M9.5 7v10M14.5 7v10"/>'
};

function icon(tone: StatusBanner['tone']): string {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[tone]}</svg>`;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n > 1 ? 's' : ''}`;
}

function bannerText(banner: StatusBanner): string {
    switch (banner.tone) {
        case 'up':
            return banner.watched === 1 ? 'Le service fonctionne' : 'Tous les services fonctionnent';
        case 'down':
            if (banner.down < banner.watched) {
                return `Panne en cours sur ${plural(banner.down, 'service')} sur ${banner.watched}`;
            }
            return banner.watched === 1 ? 'Le service est en panne' : 'Tous les services sont en panne';
        case 'pending':
            return 'Vérification en cours';
        case 'paused':
            return 'Surveillance suspendue';
    }
}

function renderBanner(view: StatusPageView): string {
    const { banner } = view;
    return `<section class="banner banner--${banner.tone}" role="status">
            <span class="banner-icon">${icon(banner.tone)}</span>
            <div>
                <strong>${bannerText(banner)}</strong>
                <span class="meta">Mis à jour le ${moment(view.generatedAt)}</span>
            </div>
        </section>`;
}

function reasonSuffix(incident: StatusIncidentView): string {
    return incident.reason === null ? '' : ` · ${escapeHtml(incident.reason)}`;
}

function renderOngoing(view: StatusPageView): string {
    if (view.ongoing.length === 0) return '';
    const items = view.ongoing
        .map(
            (incident) => `<li>
                    <span class="incident-name">${escapeHtml(incident.service)}</span>
                    <span class="incident-meta">En panne depuis le ${moment(incident.startedAt)} (${formatDuration(Math.max(0, view.generatedAt - incident.startedAt))})${reasonSuffix(incident)}</span>
                </li>`
        )
        .join('');
    return `<section class="panel panel--alert" aria-labelledby="ongoing-title">
            <h2 id="ongoing-title">${view.ongoing.length > 1 ? 'Pannes en cours' : 'Panne en cours'}</h2>
            <ul class="incidents">${items}</ul>
        </section>`;
}

const STATE_LABELS: Record<ServiceState, string> = {
    up: 'Opérationnel',
    down: 'Hors service',
    pending: 'En attente de mesure',
    paused: 'Surveillance suspendue'
};

const TONE_LABELS: Record<BarTone, string> = {
    up: 'Opérationnel',
    degraded: 'Perturbations',
    down: 'Panne',
    empty: 'Aucune mesure'
};

function barTip(bar: StatusBar): string {
    const parts = [dayFormat.format(new Date(bar.day * 1000))];
    if (bar.ratio === null && bar.downSeconds === 0) parts.push('aucune mesure');
    if (bar.ratio !== null) parts.push(formatRatio(bar.ratio));
    if (bar.downSeconds > 0) parts.push(`panne de ${formatDuration(bar.downSeconds)}`);
    else if (bar.tone === 'degraded') parts.push('quelques sondes en échec');
    return parts.join(' · ');
}

/** Ce que la bande dit à qui ne la voit pas : le détail jour par jour vit dans l'historique. */
function barsLabel(service: StatusServiceView): string {
    const downDays = service.bars.filter((bar) => bar.tone === 'down').length;
    const ratio = service.ratio === null ? 'aucune mesure' : formatRatio(service.ratio);
    const outages = downDays === 0 ? 'aucun jour de panne' : `${plural(downDays, 'jour')} avec une panne`;
    return `Disponibilité sur ${UPTIME_PAGE_DAYS} jours : ${ratio}, ${outages}.`;
}

/** La courbe de latence, sur une échelle propre à chaque service : c'est sa forme qui parle. */
function sparkline(points: readonly (number | null)[]): string {
    const values = points.filter((value): value is number => value !== null);
    if (values.length < 2) return '';
    const width = 240;
    const height = 30;
    const min = Math.min(...values);
    const span = Math.max(...values) - min || 1;
    let path = '';
    let drawing = false;
    points.forEach((value, i) => {
        if (value === null) {
            drawing = false;
            return;
        }
        const x = ((i / (points.length - 1)) * width).toFixed(1);
        const y = (height - 2 - ((value - min) / span) * (height - 4)).toFixed(1);
        path += `${drawing ? 'L' : 'M'}${x} ${y}`;
        drawing = true;
    });
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><path d="${path}"/></svg>`;
}

function renderLatency(service: StatusServiceView): string {
    // Un service en pause n'a rien mesuré : la ligne ne dirait que son absence.
    if (service.latency === null || service.state === 'paused') return '';
    const average =
        service.latency.avgMs === null
            ? `aucune mesure sur ${LATENCY_HOURS} h`
            : `<strong>${formatMs(service.latency.avgMs)}</strong> en moyenne sur ${LATENCY_HOURS} h`;
    return `<div class="latency">${sparkline(service.latency.points)}<span>Temps de réponse : ${average}</span></div>`;
}

function renderService(service: StatusServiceView): string {
    // `tabindex="-1"` : une barre touchée au doigt montre sa bulle, sans ajouter
    // quatre-vingt-dix arrêts à la navigation au clavier.
    const bars = service.bars
        .map((bar) => `<span class="bar bar--${bar.tone}" tabindex="-1" data-tip="${escapeHtml(barTip(bar))}"></span>`)
        .join('');
    return `<li class="service">
                <div class="service-head">
                    <h3>${escapeHtml(service.name)}</h3>
                    <span class="state state--${service.state}">${STATE_LABELS[service.state]}</span>
                </div>
                <div class="bars" role="img" aria-label="${escapeHtml(barsLabel(service))}">${bars}</div>
                <div class="service-foot">
                    <span class="span-90">Il y a ${UPTIME_PAGE_DAYS} jours</span>
                    <span class="span-30">Il y a 30 jours</span>
                    <span class="ratio">${service.ratio === null ? 'Aucune mesure' : `${formatRatio(service.ratio)} sur ${UPTIME_PAGE_DAYS} jours`}</span>
                    <span>Aujourd’hui</span>
                </div>
                ${renderLatency(service)}
            </li>`;
}

function renderServices(view: StatusPageView): string {
    const legend = (['up', 'degraded', 'down', 'empty'] as const)
        .map((tone) => `<li><i class="bar--${tone}"></i>${TONE_LABELS[tone]}</li>`)
        .join('');
    const body =
        view.services.length === 0
            ? '<p class="empty">Aucun service n’est publié sur cette page.</p>'
            : `<ul class="services">${view.services.map(renderService).join('')}</ul>`;
    return `<section class="panel" aria-labelledby="services-title">
            <div class="panel-head">
                <h2 id="services-title">Services</h2>
                <ul class="legend" aria-hidden="true">${legend}</ul>
            </div>
            ${body}
        </section>`;
}

function renderHistory(view: StatusPageView): string {
    const body =
        view.history.length === 0
            ? `<p class="empty">Aucune panne ces ${HISTORY_DAYS} derniers jours.</p>`
            : `<ol class="history">${view.history
                  .map(
                      (incident) => `<li>
                    ${moment(incident.startedAt)}
                    <span class="incident-name">${escapeHtml(incident.service)}</span>
                    <span class="incident-meta">Panne de ${formatDuration(Math.max(0, (incident.endedAt ?? view.generatedAt) - incident.startedAt))}${reasonSuffix(incident)}</span>
                </li>`
                  )
                  .join('')}</ol>`;
    return `<section class="panel" aria-labelledby="history-title">
            <div class="panel-head"><h2 id="history-title">Pannes des ${HISTORY_DAYS} derniers jours</h2></div>
            ${body}
        </section>`;
}

function footer(siteUrl: string): string {
    const name =
        siteUrl.length > 0 ? `<a href="${escapeHtml(siteUrl)}" target="_blank" rel="noopener">DevEye</a>` : 'DevEye';
    return `<footer class="foot">Page de statut propulsée par ${name}</footer>`;
}

function documentOf(input: {
    title: string;
    description: string;
    theme: StatusPageView['theme'];
    body: string;
    options: RenderOptions;
    robots: boolean;
}): string {
    const theme = input.theme === 'auto' ? '' : ` data-theme="${input.theme}"`;
    const scheme = input.theme === 'auto' ? 'light dark' : input.theme;
    return `<!doctype html>
<html lang="fr"${theme}>
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="${scheme}" />
        ${input.robots ? '' : '<meta name="robots" content="noindex" />'}
        <title>${escapeHtml(input.title)}</title>
        <meta name="description" content="${escapeHtml(input.description)}" />
        <style>${STATUS_STYLE}</style>
    </head>
    <body>
        <div class="page">
            ${input.body}
            ${footer(input.options.siteUrl)}
        </div>
        ${input.options.scriptPath.length > 0 ? `<script src="${escapeHtml(input.options.scriptPath)}" defer></script>` : ''}
    </body>
</html>
`;
}

export function renderStatusPage(view: StatusPageView, options: RenderOptions): string {
    const lede = view.description.length > 0 ? `<p class="lede">${escapeHtml(view.description)}</p>` : '';
    return documentOf({
        title: `${view.title} · État des services`,
        description:
            view.description.length > 0 ? view.description.slice(0, 160) : `L’état des services de ${view.title}.`,
        theme: view.theme,
        options,
        robots: true,
        body: `<header class="top">
                <h1>${escapeHtml(view.title)}</h1>
                ${lede}
            </header>
            <main id="status">
                ${renderBanner(view)}
                ${renderOngoing(view)}
                ${renderServices(view)}
                ${renderHistory(view)}
            </main>`
    });
}

/** Une page inconnue, retirée ou servie sous le domaine d'un autre : la même réponse, qui ne dit rien de plus. */
export function renderMissingPage(options: RenderOptions): string {
    return documentOf({
        title: 'Page introuvable',
        description: 'Cette page de statut n’existe pas, ou n’est plus publiée.',
        theme: 'auto',
        options: { ...options, scriptPath: '' },
        robots: false,
        body: `<main class="missing">
                <h1>Page introuvable</h1>
                <p>Cette page de statut n’existe pas, ou n’est plus publiée.</p>
            </main>`
    });
}
