import type { ProjectPriority } from '../../contracts/domain';
import { escapeHtml } from './html';
import { BOARD_STYLE } from './style';
import type { PublicAssignee, PublicBoardView, PublicCardView, PublicColumnView } from './view';

/**
 * La page publique d'un projet, en HTML : un document complet, sans ressource
 * distante, que le script servi à côté relit toutes les minutes (`#board`). Les
 * dates sont écrites à l'heure de Paris ; le script les remet dans le fuseau du
 * visiteur.
 */

export interface RenderOptions {
    /** Où mène « DevEye » au pied de la page ; vide, pas de lien. */
    siteUrl: string;
    scriptPath: string;
}

const dayFormat = new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Europe/Paris'
});
const momentFormat = new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Paris'
});

const PRIORITY_LABELS: Record<Exclude<ProjectPriority, 'none'>, string> = {
    low: 'Priorité basse',
    normal: 'Priorité normale',
    high: 'Priorité haute'
};

const ICONS = {
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    list: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
    calendar: '<rect x="4" y="5.5" width="16" height="14" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>'
};

function icon(name: keyof typeof ICONS): string {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function timeOf(epochSeconds: number, format: 'day' | 'moment'): string {
    const date = new Date(epochSeconds * 1000);
    const text = (format === 'day' ? dayFormat : momentFormat).format(date);
    return `<time datetime="${date.toISOString()}" data-format="${format}">${escapeHtml(text)}</time>`;
}

function plural(n: number, one: string, many: string): string {
    return `${n} ${n > 1 ? many : one}`;
}

function renderPeople(people: readonly PublicAssignee[]): string {
    if (people.length === 0) return '';
    const items = people
        .map(
            (person) =>
                `<li class="avatar hue-${person.color}" title="${escapeHtml(person.name)}"><span aria-hidden="true">${escapeHtml(person.initials)}</span><span class="sr">${escapeHtml(person.name)}</span></li>`
        )
        .join('');
    return `<ul class="people" aria-label="Personnes assignées">${items}</ul>`;
}

function renderCard(card: PublicCardView): string {
    const priority =
        card.priority === 'none'
            ? ''
            : `<span class="priority priority--${card.priority}" title="${PRIORITY_LABELS[card.priority]}"><span class="sr">${PRIORITY_LABELS[card.priority]}</span></span>`;
    const excerpt = card.excerpt.length > 0 ? `<p class="excerpt">${escapeHtml(card.excerpt)}</p>` : '';

    const meta: string[] = [];
    if (card.checklist) {
        const label = `Sous-tâches : ${card.checklist.done} terminée${card.checklist.done > 1 ? 's' : ''} sur ${card.checklist.total}`;
        meta.push(
            `<span class="meta-item" title="${label}">${icon('list')}<span aria-hidden="true">${card.checklist.done}/${card.checklist.total}</span><span class="sr">${label}</span></span>`
        );
    }
    if (card.due) {
        const late = card.due.overdue ? '<span class="sr"> (en retard)</span>' : '';
        meta.push(
            `<span class="meta-item${card.due.overdue ? ' due--late' : ''}" title="Échéance">${icon('calendar')}<span class="sr">Échéance : </span>${timeOf(card.due.at, 'day')}${late}</span>`
        );
    }
    if (card.milestone) {
        const hue = card.milestone.color === null ? '' : ` hue-${card.milestone.color}`;
        meta.push(
            `<span class="meta-item milestone" title="Jalon : ${escapeHtml(card.milestone.name)}"><i class="dot${hue}" aria-hidden="true"></i><span><span class="sr">Jalon : </span>${escapeHtml(card.milestone.name)}</span></span>`
        );
    }
    const people = renderPeople(card.assignees);

    return `<li class="card">
                            <div class="card-top">${priority}<h3>${escapeHtml(card.title)}</h3></div>
                            ${excerpt}
                            ${meta.length > 0 || people ? `<div class="card-meta">${meta.join('')}${people}</div>` : ''}
                        </li>`;
}

function renderColumn(column: PublicColumnView, index: number): string {
    const id = `col-${index}`;
    const done = column.done ? `${icon('check')}<span class="sr">(colonne des tâches terminées)</span>` : '';
    const cards =
        column.cards.length > 0
            ? `<ul class="cards">${column.cards.map(renderCard).join('')}</ul>`
            : '<p class="empty">Aucune tâche</p>';
    return `<section class="column" aria-labelledby="${id}">
                    <div class="column-head">
                        <h2 id="${id}">${escapeHtml(column.name)}</h2>${done}
                        <span class="count" title="${plural(column.cards.length, 'tâche', 'tâches')}">${column.cards.length}</span>
                    </div>
                    ${cards}
                </section>`;
}

function footer(siteUrl: string): string {
    const name =
        siteUrl.length > 0 ? `<a href="${escapeHtml(siteUrl)}" target="_blank" rel="noopener">DevEye</a>` : 'DevEye';
    return `<footer class="foot">Tableau publié avec ${name}</footer>`;
}

function documentOf(input: {
    title: string;
    description: string;
    body: string;
    options: RenderOptions;
    robots: boolean;
}): string {
    return `<!doctype html>
<html lang="fr">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        ${input.robots ? '' : '<meta name="robots" content="noindex" />'}
        <title>${escapeHtml(input.title)}</title>
        <meta name="description" content="${escapeHtml(input.description)}" />
        <style>${BOARD_STYLE}</style>
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

export function renderBoardPage(view: PublicBoardView, options: RenderOptions): string {
    const iconTag = view.icon.length > 0 ? `<img src="${escapeHtml(view.icon)}" alt="" />` : '';
    const facts = [
        `<li class="status">${escapeHtml(view.status)}</li>`,
        view.version.length > 0 ? `<li>Version ${escapeHtml(view.version)}</li>` : '',
        view.cardTotal > 0
            ? `<li>${view.cardDone} ${view.cardDone > 1 ? 'tâches terminées' : 'tâche terminée'} sur ${view.cardTotal}</li>`
            : ''
    ].join('');
    const lede = view.description.length > 0 ? `<p class="lede">${escapeHtml(view.description)}</p>` : '';
    const columns =
        view.columns.length > 0
            ? `<div class="board" role="region" aria-label="Tableau du projet" tabindex="0">
                ${view.columns.map(renderColumn).join('')}
            </div>`
            : '<p class="empty">Ce tableau n’a encore aucune colonne.</p>';

    return documentOf({
        title: `${view.title} · Tableau du projet`,
        description:
            view.description.length > 0 ? view.description.slice(0, 160) : `Le tableau du projet ${view.title}.`,
        options,
        robots: true,
        body: `<main id="board">
            <header class="top">
                ${iconTag}
                <div>
                    <h1>${escapeHtml(view.title)}</h1>
                    <ul class="facts">${facts}</ul>
                </div>
            </header>
            ${lede}
            ${columns}
            <p class="updated">Mis à jour le ${timeOf(view.generatedAt, 'moment')}</p>
        </main>`
    });
}

/** Un lien inconnu, une page retirée ou servie sous le domaine d'un autre : la même réponse, qui ne dit rien de plus. */
export function renderMissingPage(options: RenderOptions): string {
    return documentOf({
        title: 'Page introuvable',
        description: 'Ce tableau n’existe pas, ou n’est plus publié.',
        options: { ...options, scriptPath: '' },
        robots: false,
        body: `<main class="missing">
                <h1>Page introuvable</h1>
                <p>Ce tableau n’existe pas, ou n’est plus publié.</p>
            </main>`
    });
}
