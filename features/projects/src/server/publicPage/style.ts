/**
 * La feuille de la page publique, en ligne dans le document : aucune ressource
 * distante, et la police du système. La page vit hors de l'app, sans son thème :
 * ses couleurs sont ses propres jetons, posés une fois par thème ci-dessous, et
 * tout le reste passe par `var()`. Le thème suit celui du visiteur.
 *
 * Les teintes des jalons et des membres sont celles de l'app, les mêmes dans les
 * deux thèmes : les initiales s'y écrivent en encre sombre, lisible sur chacune.
 */

const LIGHT = `
    color-scheme: light;
    --bg: #f5f6f8;
    --column: #eceef2;
    --card: #ffffff;
    --ink: #15171c;
    --muted: #5e6573;
    --line: #e3e6eb;
    --accent: #3a6ad6;
    --low: #1c9a52;
    --high: #d23f3f;
    --late: #c23434;
    --late-soft: #fbe9e9;
    --chip: #eef0f3;
    --dot-ring: rgba(21, 23, 28, 0.18);
    --shadow: 0 1px 2px rgba(21, 23, 28, 0.06);`;

const DARK = `
    color-scheme: dark;
    --bg: #0e1015;
    --column: #14171d;
    --card: #1b1f27;
    --ink: #e8eaef;
    --muted: #9aa2b1;
    --line: #2a303b;
    --accent: #6f9bff;
    --low: #30bd6a;
    --high: #ee5858;
    --late: #ff7b7b;
    --late-soft: #331a1c;
    --chip: #242a33;
    --dot-ring: rgba(232, 234, 239, 0.16);
    --shadow: none;`;

const HUES = `
    --avatar-ink: #15171c;
    --hue-red: #ff6b81;
    --hue-orange: #ff9f43;
    --hue-yellow: #ffd54a;
    --hue-green: #5ed17c;
    --hue-blue: #4da8ff;
    --hue-indigo: #7c8cff;
    --hue-purple: #b088ff;
    --hue-pink: #ff7ac6;`;

const HUE_NAMES = ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'purple', 'pink'];

export const BOARD_STYLE = `
:root {${LIGHT}${HUES}
}
@media (prefers-color-scheme: dark) {
    :root {${DARK}
    }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
    margin: 0;
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
.status { padding: 1px 9px; border-radius: 999px; background: var(--chip); color: var(--ink); font-weight: 600; }
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
.card h3 { margin: 0; font-size: 14px; line-height: 1.4; font-weight: 600; overflow-wrap: anywhere; }
.priority { flex: none; width: 7px; height: 7px; margin-top: 7px; border-radius: 50%; }
.priority--low { background: var(--low); }
.priority--normal { background: var(--accent); }
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
.avatar {
    display: grid; place-items: center; width: 22px; height: 22px; margin-left: -6px;
    border-radius: 50%; border: 2px solid var(--card);
    color: var(--avatar-ink); font-size: 9px; font-weight: 700; letter-spacing: 0.02em;
}
${HUE_NAMES.map((hue) => `.hue-${hue} { background: var(--hue-${hue}); }`).join('\n')}

.updated { margin: 18px 0 0; color: var(--muted); font-size: 12px; }
.foot { margin-top: 28px; text-align: center; font-size: 12px; color: var(--muted); }
.foot a { color: inherit; font-weight: 600; text-decoration: none; }
.foot a:hover, .foot a:focus-visible { text-decoration: underline; }
.missing { max-width: 560px; margin: 0 auto; padding: 64px 0 32px; text-align: center; }
.missing h1 { margin: 0 0 8px; font-size: 24px; }
.missing p { margin: 0; color: var(--muted); }

@media (max-width: 640px) {
    .page { padding-top: 24px; }
    .top h1 { font-size: 23px; }
    .top img { width: 44px; height: 44px; }
    .board { grid-auto-flow: row; grid-auto-columns: auto; overflow-x: visible; }
}
`;
