import { formatDuration, formatRatio } from '../features/uptime/src/contracts/format';
import { escapeHtml } from '../features/uptime/src/server/statusPage/html';
import { STATUS_STYLE } from '../features/uptime/src/server/statusPage/style';
import {
    HISTORY_DAYS,
    PAGE_DAYS,
    type BannerTone,
    type ComponentView,
    type IncidentView,
    type PickerEntry,
    type ShownState,
    type StatusBar,
    type StatusView
} from './view';

/**
 * La page d'état en HTML, avec la présentation des pages de statut d'Uptime :
 * un document complet, sans ressource distante, que le script servi à côté
 * relit chaque minute (`#status`). Les heures sont écrites en UTC, le script
 * les remet dans le fuseau du visiteur.
 */

export const SCRIPT_PATH = '/page.js';
export const ICON_PATH = '/deveye-icon.png';

export interface RenderOptions {
    /** Le site vitrine, au pied de la page ; `null`, pas de lien. */
    siteUrl: string | null;
    /** L'app, pour y retourner. */
    appUrl: string;
}

/** Ce que la page ajoute aux jetons d'Uptime : la maintenance, et le sélecteur. */
const EXTRA_STYLE = `
:root {
    --maintenance: var(--accent);
    --maintenance-soft: color-mix(in srgb, var(--accent) 14%, var(--card));
}
.banner--maintenance { background: var(--maintenance-soft); border-color: transparent; }
.banner--maintenance .banner-icon { background: var(--maintenance); }
.banner--degraded { background: var(--degraded-soft); border-color: transparent; }
.banner--degraded .banner-icon { background: var(--degraded); }
.banner .detail { display: block; margin-top: 2px; }
.notice { margin: 0 0 20px; padding: 14px 18px; border-radius: 12px; background: var(--card); border: 1px solid var(--line); white-space: pre-line; overflow-wrap: anywhere; }
.bar--maintenance, .legend .bar--maintenance { background: var(--maintenance); }
.state--degraded { color: var(--degraded); }
.state--maintenance { color: var(--maintenance); }
.top { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 20px; }
.back { display: inline-block; margin-bottom: 6px; color: var(--muted); font-size: 13px; text-decoration: none; }
.back:hover, .back:focus-visible { color: var(--ink); text-decoration: underline; }
.picker { position: relative; }
.picker summary {
    display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px;
    border-radius: 10px; border: 1px solid var(--line); background: var(--card);
    font-size: 14px; cursor: pointer; list-style: none; user-select: none;
}
.picker summary::-webkit-details-marker { display: none; }
.picker summary::after { content: ''; width: 6px; height: 6px; border: solid var(--muted); border-width: 0 2px 2px 0; transform: translateY(-2px) rotate(45deg); }
.picker[open] summary::after { transform: translateY(1px) rotate(-135deg); }
.picker summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.picker ul {
    position: absolute; right: 0; z-index: 5; min-width: 240px; max-height: 60vh; overflow-y: auto;
    margin: 6px 0 0; padding: 6px; list-style: none;
    border-radius: 10px; border: 1px solid var(--line); background: var(--card); box-shadow: var(--shadow);
}
.picker a { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 6px; color: var(--ink); text-decoration: none; }
.picker a:hover, .picker a:focus-visible { background: var(--bg); }
.picker a[aria-current='page'] { font-weight: 600; }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--empty); }
.dot--up { background: var(--up); }
.dot--degraded { background: var(--degraded); }
.dot--down { background: var(--down); }
.dot--maintenance { background: var(--maintenance); }
@media (max-width: 600px) {
    .picker ul { left: 0; right: auto; }
}
`;

const dayFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const momentFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

function moment(epochSeconds: number): string {
    const date = new Date(epochSeconds * 1000);
    return `<time datetime="${date.toISOString()}" data-format="moment">${escapeHtml(momentFormat.format(date))} UTC</time>`;
}

const ICONS: Record<BannerTone, string> = {
    up: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    down: '<path d="M12 6.5v7M12 17.5h.01"/>',
    degraded: '<path d="M12 6.5v7M12 17.5h.01"/>',
    maintenance: '<path d="M14.5 6.5a4 4 0 0 0-5 5L5 16l3 3 4.5-4.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z"/>',
    pending: '<circle cx="12" cy="12" r="7.5"/><path d="M12 8v4.5l2.5 2"/>'
};

function icon(tone: BannerTone): string {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[tone]}</svg>`;
}

const STATE_LABELS: Record<ShownState, string> = {
    up: 'Opérationnel',
    degraded: 'Perturbé',
    down: 'Hors service',
    maintenance: 'En maintenance',
    pending: 'En attente de mesure'
};

const INCIDENT_LABELS: Record<IncidentView['state'], string> = {
    down: 'Hors service',
    degraded: 'Perturbations',
    maintenance: 'Maintenance'
};

const TONE_LABELS = {
    up: 'Opérationnel',
    degraded: 'Perturbations',
    maintenance: 'Maintenance',
    down: 'Panne',
    empty: 'Aucune mesure'
} as const;

function renderBanner(view: StatusView): string {
    const { banner } = view;
    const detail = banner.detail ? `<span class="meta detail">${escapeHtml(banner.detail)}</span>` : '';
    return `<section class="banner banner--${banner.tone}" role="status">
            <span class="banner-icon">${icon(banner.tone)}</span>
            <div>
                <strong>${escapeHtml(banner.title)}</strong>
                ${detail}
                <span class="meta">Mis à jour le ${moment(view.generatedAt)}</span>
            </div>
        </section>
        ${banner.message ? `<p class="notice">${escapeHtml(banner.message)}</p>` : ''}`;
}

function suffix(incident: IncidentView): string {
    return incident.reason ? ` · ${escapeHtml(incident.reason)}` : '';
}

function renderOngoing(view: StatusView): string {
    if (view.ongoing.length === 0) return '';
    const items = view.ongoing
        .map(
            (incident) => `<li>
                    <span class="incident-name">${escapeHtml(incident.label)}</span>
                    <span class="incident-meta">${INCIDENT_LABELS[incident.state]} depuis le ${moment(incident.startedAt)} (${formatDuration(Math.max(0, view.generatedAt - incident.startedAt))})${suffix(incident)}</span>
                </li>`
        )
        .join('');
    return `<section class="panel panel--alert" aria-labelledby="ongoing-title">
            <h2 id="ongoing-title">En cours</h2>
            <ul class="incidents">${items}</ul>
        </section>`;
}

function barTip(bar: StatusBar): string {
    const parts = [dayFormat.format(new Date(bar.day * 1000))];
    if (bar.ratio === null) parts.push('aucune mesure');
    else parts.push(formatRatio(bar.ratio));
    if (bar.downSeconds > 0) parts.push(`hors service ${formatDuration(bar.downSeconds)}`);
    if (bar.maintenanceSeconds > 0) parts.push(`maintenance ${formatDuration(bar.maintenanceSeconds)}`);
    if (bar.tone === 'degraded') parts.push('perturbations');
    return parts.join(' · ');
}

function barsLabel(c: ComponentView): string {
    const ratio = c.ratio === null ? 'aucune mesure' : formatRatio(c.ratio);
    const bad = c.bars.filter((b) => b.tone === 'down' || b.tone === 'maintenance').length;
    const days =
        bad === 0 ? 'aucun jour d’indisponibilité' : `${bad} jour${bad > 1 ? 's' : ''} avec une indisponibilité`;
    return `Disponibilité sur ${PAGE_DAYS} jours : ${ratio}, ${days}.`;
}

function sinceText(c: ComponentView, now: number): string {
    if (c.state === 'up' || c.state === 'pending' || c.since === null) return '';
    const label = c.inherited ? 'comme DevEye' : `depuis ${formatDuration(Math.max(0, now - c.since))}`;
    return `<p class="cadence">${STATE_LABELS[c.state]} ${label}${c.reason && !c.inherited ? ` · ${escapeHtml(c.reason)}` : ''}</p>`;
}

function renderComponent(c: ComponentView, now: number): string {
    const bars = c.bars
        .map((bar) => `<span class="bar bar--${bar.tone}" tabindex="-1" data-tip="${escapeHtml(barTip(bar))}"></span>`)
        .join('');
    return `<li class="service">
                <div class="service-head">
                    <h3>${escapeHtml(c.label)}</h3>
                    <span class="state state--${c.state}">${STATE_LABELS[c.state]}</span>
                </div>
                <div class="bars" role="img" aria-label="${escapeHtml(barsLabel(c))}">${bars}</div>
                <div class="service-foot">
                    <span class="span-90">Il y a ${PAGE_DAYS} jours</span>
                    <span class="span-30">Il y a 30 jours</span>
                    <span class="ratio">${c.ratio === null ? 'Aucune mesure' : `${formatRatio(c.ratio)} sur ${PAGE_DAYS} jours`}</span>
                    <span>Aujourd’hui</span>
                </div>
                ${sinceText(c, now)}
            </li>`;
}

function renderComponents(view: StatusView): string {
    const legend = (['up', 'degraded', 'maintenance', 'down', 'empty'] as const)
        .map((tone) => `<li><i class="bar--${tone}"></i>${TONE_LABELS[tone]}</li>`)
        .join('');
    return `<section class="panel" aria-labelledby="services-title">
            <div class="panel-head">
                <h2 id="services-title">${view.feature ? 'Disponibilité' : 'Services'}</h2>
                <ul class="legend" aria-hidden="true">${legend}</ul>
            </div>
            <ul class="services">${view.components.map((c) => renderComponent(c, view.generatedAt)).join('')}</ul>
        </section>`;
}

function renderHistory(view: StatusView): string {
    const body =
        view.history.length === 0
            ? `<p class="empty">Aucun incident ces ${HISTORY_DAYS} derniers jours.</p>`
            : `<ol class="history">${view.history
                  .map(
                      (incident) => `<li>
                    ${moment(incident.startedAt)}
                    <span class="incident-name">${escapeHtml(incident.label)}</span>
                    <span class="incident-meta">${INCIDENT_LABELS[incident.state]} ${incident.endedAt === null ? 'en cours depuis' : 'pendant'} ${formatDuration(Math.max(0, (incident.endedAt ?? view.generatedAt) - incident.startedAt))}${suffix(incident)}</span>
                </li>`
                  )
                  .join('')}</ol>`;
    return `<section class="panel" aria-labelledby="history-title">
            <div class="panel-head"><h2 id="history-title">Incidents des ${HISTORY_DAYS} derniers jours</h2></div>
            ${body}
        </section>`;
}

function renderPicker(picker: readonly PickerEntry[], current: string | null): string {
    if (picker.length === 0) return '';
    const currentLabel = picker.find((p) => p.id === current)?.label ?? 'Vue d’ensemble';
    const entry = (href: string, label: string, dot: string, active: boolean) =>
        `<li><a href="${href}"${active ? ' aria-current="page"' : ''}>${dot}${escapeHtml(label)}</a></li>`;
    const items = [
        entry('/', 'Vue d’ensemble', '<span class="dot" aria-hidden="true"></span>', current === null),
        ...picker.map((p) =>
            entry(
                `/${encodeURIComponent(p.id)}`,
                p.label,
                `<span class="dot dot--${p.state}" title="${STATE_LABELS[p.state]}"></span>`,
                p.id === current
            )
        )
    ].join('');
    return `<details class="picker">
                <summary aria-label="Choisir une fonctionnalité, actuellement : ${escapeHtml(currentLabel)}">${escapeHtml(currentLabel)}</summary>
                <ul>${items}</ul>
            </details>`;
}

function footer(options: RenderOptions): string {
    const links = [`<a href="${escapeHtml(options.appUrl)}">Ouvrir DevEye</a>`];
    if (options.siteUrl) {
        const site = escapeHtml(options.siteUrl);
        links.push(`<a href="${site}" target="_blank" rel="noopener">Site de DevEye</a>`);
        links.push(`<a href="${site}/confidentialite" target="_blank" rel="noopener">Confidentialité</a>`);
    }
    return `<footer class="foot">${links.join(' · ')}</footer>`;
}

function documentOf(input: {
    title: string;
    description: string;
    body: string;
    options: RenderOptions;
    script: boolean;
}): string {
    return `<!doctype html>
<html lang="fr">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>${escapeHtml(input.title)}</title>
        <link rel="icon" href="${ICON_PATH}" />
        <meta name="description" content="${escapeHtml(input.description)}" />
        <style>${STATUS_STYLE}${EXTRA_STYLE}</style>
    </head>
    <body>
        <div class="page">
            ${input.body}
            ${footer(input.options)}
        </div>
        ${input.script ? `<script src="${SCRIPT_PATH}" defer></script>` : ''}
    </body>
</html>
`;
}

export function renderStatus(view: StatusView, options: RenderOptions): string {
    const heading = view.feature
        ? `<a class="back" href="/">← Tous les services</a><h1>${escapeHtml(view.feature.label)}</h1>`
        : '<h1>État de DevEye</h1>';
    return documentOf({
        title: view.feature ? `${view.feature.label} · État de DevEye` : 'État de DevEye',
        description: view.feature
            ? `La disponibilité de « ${view.feature.label} » dans DevEye, ses incidents en cours et passés.`
            : 'La disponibilité de DevEye et de ses fonctionnalités, les incidents en cours et passés.',
        options,
        script: true,
        body: `<header class="top">
                <div>${heading}</div>
                ${renderPicker(view.picker, view.feature?.id ?? null)}
            </header>
            <main id="status">
                ${renderBanner(view)}
                ${renderOngoing(view)}
                ${renderComponents(view)}
                ${renderHistory(view)}
            </main>`
    });
}

export function renderMissing(options: RenderOptions): string {
    return documentOf({
        title: 'Page introuvable · État de DevEye',
        description: 'Cette fonctionnalité n’existe pas, ou n’est plus suivie.',
        options,
        script: false,
        body: `<main class="missing">
                <h1>Page introuvable</h1>
                <p>Cette fonctionnalité n’existe pas, ou n’est plus suivie. <a href="/">Voir tous les services</a></p>
            </main>`
    });
}
