import { accentSoft, PAGE_ACCENTS, resolvePageAccent, type PageTheme } from '@deveye/types/sdk';

import { PUBLIC_BOARD_PALETTE } from '../../contracts/domain';

/**
 * La feuille de la page publique, en ligne dans le document : aucune ressource
 * distante, et la police du système. La page vit hors de l'app, sans son thème :
 * ses couleurs sont celles de `PUBLIC_BOARD_PALETTE`, posées une fois par thème
 * ci-dessous, et tout le reste passe par `var()`.
 *
 * Sans `data-theme` sur la racine, la page suit le visiteur ; avec, le choix du
 * propriétaire l'emporte. Les teintes des jalons et des membres sont celles de
 * l'app, les mêmes dans les deux thèmes : les initiales s'y écrivent en encre
 * sombre, lisible sur chacune.
 */

function tokens(theme: PageTheme): string {
    const palette = PUBLIC_BOARD_PALETTE[theme];
    return [
        `color-scheme: ${theme};`,
        ...Object.entries(palette).map(([name, value]) => `--${name}: ${value};`),
        `--accent-soft: ${accentSoft(palette.accent, theme)};`
    ].join('\n    ');
}

/** Les trois sélecteurs de la palette, dans l'ordre où la feuille les pose. */
function byTheme(block: (theme: PageTheme) => string): string {
    return `
:root {
    ${block('light')}
}
:root[data-theme='dark'] {
    ${block('dark')}
}
@media (prefers-color-scheme: dark) {
    :root:not([data-theme='light']) {
        ${block('dark')}
    }
}`;
}

/**
 * L'accent choisi, à poser après la feuille sous les mêmes sélecteurs que la
 * palette : à spécificité égale, le dernier l'emporte. Vide pour l'accent
 * d'origine, et rien de ce que le propriétaire écrit n'en sort tel quel.
 */
export function accentStyle(accent: string): string {
    const hex = resolvePageAccent(accent);
    if (hex === null) return '';
    return byTheme((theme) => `--accent: ${hex}; --accent-soft: ${accentSoft(hex, theme)};`);
}

/** Les teintes des jalons et des membres, celles des comptes de l'app. */
const HUES = Object.entries(PAGE_ACCENTS)
    .map(([name, hex]) => `--hue-${name}: ${hex};`)
    .join('\n    ');

export const BOARD_STYLE = `${byTheme(tokens)}
:root {
    ${HUES}
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
    margin: 0;
    border-top: 4px solid var(--accent);
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}
.page { max-width: 1320px; margin: 0 auto; padding: 40px 20px 28px; }
.sr {
    position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.top { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; }
.top img { flex: none; width: 52px; height: 52px; border-radius: 12px; object-fit: cover; }
.top h1 { margin: 0; font-size: 28px; line-height: 1.2; font-weight: 700; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.facts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; margin: 6px 0 0; padding: 0; list-style: none; color: var(--muted); font-size: 13px; }
.status { padding: 1px 9px; border-radius: 999px; background: var(--accent-soft); color: var(--ink); font-weight: 600; }
.progress { max-width: 320px; height: 6px; margin: 10px 0 0; border-radius: 999px; background: var(--chip); overflow: hidden; }
.progress span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
.lede { max-width: 72ch; margin: 0 0 24px; color: var(--muted); white-space: pre-line; overflow-wrap: anywhere; }

.board {
    display: grid; grid-auto-flow: column; grid-auto-columns: minmax(260px, 300px);
    gap: 14px; align-items: start;
    overflow-x: auto; padding: 2px 2px 14px; margin: 0 -2px;
    outline: none;
}
.board:focus-visible { box-shadow: 0 0 0 2px var(--accent); border-radius: 12px; }
.column { padding: 12px; border-radius: 12px; background: var(--column); }
.column-head { display: flex; align-items: center; gap: 8px; margin: 0 2px 10px; }
.column-head h2 { margin: 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.column-head svg { flex: none; width: 15px; height: 15px; color: var(--low); }
.count { margin-left: auto; min-width: 22px; padding: 0 7px; border-radius: 999px; background: var(--chip); color: var(--muted); font-size: 12px; font-weight: 600; text-align: center; }
.cards { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.empty { margin: 0 2px; color: var(--muted); font-size: 13px; }

.card {
    padding: 10px 12px; border-radius: 10px;
    background: var(--card); border: 1px solid var(--line); box-shadow: var(--shadow);
}
.card-top { display: flex; align-items: flex-start; gap: 8px; }
.card-title { display: block; margin: 0; font-size: 14px; line-height: 1.4; font-weight: 600; overflow-wrap: anywhere; }
.card summary { display: block; list-style: none; cursor: pointer; border-radius: 6px; outline: none; }
.card summary::-webkit-details-marker { display: none; }
.card summary:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
.chevron { flex: none; margin: 2px 0 0 auto; color: var(--muted); }
.chevron svg { display: block; width: 16px; height: 16px; transition: transform 0.15s; }
details[open] .chevron svg { transform: rotate(180deg); }
.subtasks { display: grid; gap: 6px; margin: 10px 0 0; padding: 10px 0 0; border-top: 1px solid var(--line); list-style: none; font-size: 13px; }
.subtask { display: flex; align-items: flex-start; gap: 8px; }
.subtask svg { flex: none; width: 15px; height: 15px; margin-top: 2px; color: var(--muted); }
.subtask--done svg { color: var(--low); }
.subtask--done .subtask-label { color: var(--muted); text-decoration: line-through; }
.subtask-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.subtask .avatar { flex: none; margin-left: 0; }
.priority { flex: none; width: 7px; height: 7px; margin-top: 7px; border-radius: 50%; }
.priority--low { background: var(--low); }
.priority--normal { background: var(--normal); }
.priority--high { background: var(--high); }
.excerpt {
    margin: 4px 0 0; color: var(--muted); font-size: 13px; line-height: 1.45; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
}
.card-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 8px; font-size: 12px; color: var(--muted); }
.card-meta:empty { display: none; }
.meta-item { display: inline-flex; align-items: center; gap: 4px; font-variant-numeric: tabular-nums; }
.meta-item svg { width: 13px; height: 13px; }
.due--late { padding: 0 6px; border-radius: 6px; background: var(--late-soft); color: var(--late); font-weight: 600; }
.milestone { max-width: 100%; }
.milestone span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--muted); box-shadow: inset 0 0 0 1px var(--dot-ring); }
.people { display: flex; margin: 0 0 0 auto; padding: 0 0 0 6px; list-style: none; }
.people .avatar:first-child { margin-left: 0; }
.avatar {
    display: grid; place-items: center; width: 22px; height: 22px; margin-left: -6px;
    border-radius: 50%; border: 2px solid var(--card);
    color: var(--avatar-ink); font-size: 9px; font-weight: 700; letter-spacing: 0.02em;
}
${Object.keys(PAGE_ACCENTS)
    .map((hue) => `.hue-${hue} { background: var(--hue-${hue}); }`)
    .join('\n')}

.updated { margin: 18px 0 0; color: var(--muted); font-size: 12px; }
.foot { margin-top: 28px; text-align: center; font-size: 12px; color: var(--muted); }
.foot a { color: inherit; font-weight: 600; text-decoration: none; }
.foot a:hover, .foot a:focus-visible { text-decoration: underline; }
.missing { max-width: 560px; margin: 0 auto; padding: 64px 0 32px; text-align: center; }
.missing h1 { margin: 0 0 8px; font-size: 24px; }
.missing p { margin: 0; color: var(--muted); }

@media (prefers-reduced-motion: reduce) {
    .chevron svg { transition: none; }
}
@media (max-width: 640px) {
    .page { padding-top: 24px; }
    .top h1 { font-size: 23px; }
    .top img { width: 44px; height: 44px; }
    .board { grid-auto-flow: row; grid-auto-columns: auto; overflow-x: visible; }
}
`;
