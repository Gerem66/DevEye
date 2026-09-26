import { DEVEYE_ICON_PATH, type PageThemeChoice } from '@deveye/types/sdk';

import type { ProjectPriority } from '../../contracts/domain';
import { escapeHtml } from './html';
import { accentStyle, BOARD_STYLE } from './style';
import type { PublicAssignee, PublicBoardView, PublicCardView, PublicColumnView, PublicSubtaskView } from './view';

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
    box: '<rect x="4" y="4" width="16" height="16" rx="3"/>',
    chevron: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
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

/**
 * Les balises d'une carte. Celle qui se déplie tient tout son contenu dans un
 * `<summary>`, qui n'admet que du texte en ligne : les mêmes classes, portées
 * par des `span`.
 */
interface CardTags {
    block: string;
    para: string;
    title: string;
    list: string;
    item: string;
    listLabel: string;
}

const PLAIN: CardTags = {
    block: 'div',
    para: 'p',
    title: 'h3',
    list: 'ul',
    item: 'li',
    listLabel: ' aria-label="Personnes assignées"'
};
const INLINE: CardTags = { block: 'span', para: 'span', title: 'span', list: 'span', item: 'span', listLabel: '' };

function avatarOf(person: PublicAssignee, tag: string): string {
    return `<${tag} class="avatar hue-${person.color}" title="${escapeHtml(person.name)}"><span aria-hidden="true">${escapeHtml(person.initials)}</span><span class="sr">${escapeHtml(person.name)}</span></${tag}>`;
}

function renderPeople(people: readonly PublicAssignee[], tags: CardTags): string {
    if (people.length === 0) return '';
    const items = people.map((person) => avatarOf(person, tags.item)).join('');
    return `<${tags.list} class="people"${tags.listLabel}>${items}</${tags.list}>`;
}

function renderSubtask(subtask: PublicSubtaskView): string {
    const done = subtask.done ? '<span class="sr"> (terminée)</span>' : '';
    const who = subtask.assignee ? avatarOf(subtask.assignee, 'span') : '';
    return `<li class="subtask${subtask.done ? ' subtask--done' : ''}">${icon(subtask.done ? 'list' : 'box')}<span class="subtask-label">${escapeHtml(subtask.label)}${done}</span>${who}</li>`;
}

function renderCard(card: PublicCardView): string {
    const tags = card.subtasks === null ? PLAIN : INLINE;
    const priority =
        card.priority === 'none'
            ? ''
            : `<span class="priority priority--${card.priority}" title="${PRIORITY_LABELS[card.priority]}"><span class="sr">${PRIORITY_LABELS[card.priority]}</span></span>`;
    const excerpt =
        card.excerpt.length > 0 ? `<${tags.para} class="excerpt">${escapeHtml(card.excerpt)}</${tags.para}>` : '';

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
    const people = renderPeople(card.assignees, tags);
    const chevron = card.subtasks === null ? '' : `<span class="chevron">${icon('chevron')}</span>`;
    const body = `<${tags.block} class="card-top">${priority}<${tags.title} class="card-title">${escapeHtml(card.title)}</${tags.title}>${chevron}</${tags.block}>${excerpt}${
        meta.length > 0 || people ? `<${tags.block} class="card-meta">${meta.join('')}${people}</${tags.block}>` : ''
    }`;
    if (card.subtasks === null) return `<li class="card">${body}</li>`;
    const subtasks = card.subtasks.map(renderSubtask).join('');
    return `<li class="card"><details data-card="${card.id}"><summary>${body}</summary><ul class="subtasks" aria-label="Sous-tâches">${subtasks}</ul></details></li>`;
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

/** Le site porte aussi la politique de confidentialité : un visiteur anonyme doit pouvoir la lire d'ici. */
function footer(siteUrl: string): string {
    if (siteUrl.length === 0) return '<footer class="foot">Tableau publié avec DevEye</footer>';
    const site = escapeHtml(siteUrl);
    const privacy = `<a href="${site}/confidentialite" target="_blank" rel="noopener">Confidentialité</a>`;
    return `<footer class="foot">Tableau publié avec <a href="${site}" target="_blank" rel="noopener">DevEye</a> · ${privacy}</footer>`;
}

function documentOf(input: {
    title: string;
    description: string;
    body: string;
    options: RenderOptions;
    robots: boolean;
    theme: PageThemeChoice;
    accent: string;
    /** L'adresse de l'icône d'onglet. */
    icon: string;
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
        <link rel="icon" href="${escapeHtml(input.icon)}" />
        <meta name="description" content="${escapeHtml(input.description)}" />
        <style>${BOARD_STYLE}${accentStyle(input.accent)}</style>
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
    const progress =
        view.cardTotal > 0
            ? `<div class="progress" aria-hidden="true"><span style="width: ${Math.round((view.cardDone / view.cardTotal) * 100)}%"></span></div>`
            : '';
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
        theme: view.theme,
        accent: view.accent,
        // La même adresse que la page : ses gardes valent pour sa vignette.
        icon: view.icon.length > 0 ? '?icone' : DEVEYE_ICON_PATH,
        body: `<main id="board">
            <header class="top">
                ${iconTag}
                <div>
                    <h1>${escapeHtml(view.title)}</h1>
                    <ul class="facts">${facts}</ul>
                    ${progress}
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
        theme: 'auto',
        accent: '',
        icon: DEVEYE_ICON_PATH,
        body: `<main class="missing">
                <h1>Page introuvable</h1>
                <p>Ce tableau n’existe pas, ou n’est plus publié.</p>
            </main>`
    });
}
