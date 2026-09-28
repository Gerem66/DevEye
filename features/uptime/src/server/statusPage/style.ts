/**
 * La feuille de la page de statut, en ligne dans le document : aucune
 * ressource distante, et la police du système. La page vit hors de l'app, sans
 * son thème : ses couleurs sont ses propres jetons, posés une fois par thème
 * ci-dessous, et tout le reste passe par `var()`.
 *
 * `auto` suit le thème du visiteur ; `light` et `dark`, posés par le
 * propriétaire de la page, l'emportent sur lui.
 */

const LIGHT = `
    color-scheme: light;
    --bg: #f5f6f8;
    --card: #ffffff;
    --ink: #15171c;
    --muted: #5e6573;
    --line: #e3e6eb;
    --accent: #3a6ad6;
    --up: #1c9a52;
    --up-soft: #e5f4eb;
    --degraded: #d0921a;
    --degraded-soft: #fbf2df;
    --down: #d23f3f;
    --down-soft: #fbe9e9;
    --paused: #858d9c;
    --paused-soft: #eef0f3;
    --empty: #d4d9e1;
    --tip-bg: #15171c;
    --tip-ink: #ffffff;
    --shadow: 0 1px 2px rgba(21, 23, 28, 0.05), 0 6px 20px rgba(21, 23, 28, 0.04);`;

const DARK = `
    color-scheme: dark;
    --bg: #0e1015;
    --card: #161920;
    --ink: #e8eaef;
    --muted: #9aa2b1;
    --line: #262b35;
    --accent: #6f9bff;
    --up: #30bd6a;
    --up-soft: #122a1d;
    --degraded: #e3a93a;
    --degraded-soft: #2d2413;
    --down: #ee5858;
    --down-soft: #301618;
    --paused: #7f8797;
    --paused-soft: #1e222a;
    --empty: #2c323d;
    --tip-bg: #e8eaef;
    --tip-ink: #15171c;
    --shadow: none;`;

export const STATUS_STYLE = `
:root {${LIGHT}
}
:root[data-theme='dark'] {${DARK}
}
@media (prefers-color-scheme: dark) {
    :root:not([data-theme='light']) {${DARK}
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
.page { max-width: 760px; margin: 0 auto; padding: 48px 20px 32px; }
.top { margin-bottom: 28px; }
.top h1 { margin: 0; font-size: 28px; line-height: 1.2; font-weight: 700; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.lede { margin: 8px 0 0; color: var(--muted); white-space: pre-line; overflow-wrap: anywhere; }

.banner {
    display: flex; align-items: center; gap: 14px;
    padding: 18px 20px; margin-bottom: 20px;
    border-radius: 12px; background: var(--card); border: 1px solid var(--line); box-shadow: var(--shadow);
}
.banner-icon {
    flex: none; width: 38px; height: 38px; border-radius: 50%;
    display: grid; place-items: center; color: var(--card);
}
.banner-icon svg { width: 20px; height: 20px; }
.banner strong { display: block; font-size: 17px; line-height: 1.3; }
.banner span.meta { color: var(--muted); font-size: 13px; }
.banner--up { background: var(--up-soft); border-color: transparent; }
.banner--up .banner-icon { background: var(--up); }
.banner--down { background: var(--down-soft); border-color: transparent; }
.banner--down .banner-icon { background: var(--down); }
.banner--pending { background: var(--degraded-soft); border-color: transparent; }
.banner--pending .banner-icon { background: var(--degraded); }
.banner--paused { background: var(--paused-soft); border-color: transparent; }
.banner--paused .banner-icon { background: var(--paused); }

.panel {
    padding: 20px; margin-bottom: 20px;
    border-radius: 12px; background: var(--card); border: 1px solid var(--line); box-shadow: var(--shadow);
}
.panel h2 { margin: 0; font-size: 15px; font-weight: 600; }
.panel-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 14px; }
.panel--alert { border-color: var(--down); }
.panel--alert h2 { color: var(--down); margin-bottom: 12px; }

.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; list-style: none; font-size: 12px; color: var(--muted); }
.legend li { display: inline-flex; align-items: center; gap: 6px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }

.services { margin: 0; padding: 0; list-style: none; }
.service { padding: 16px 0; border-top: 1px solid var(--line); }
.service:first-child { padding-top: 2px; border-top: 0; }
.service:last-child { padding-bottom: 0; }
.service-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.service-head h3 { margin: 0; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.state { flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
.state::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.state--up { color: var(--up); }
.state--down { color: var(--down); }
.state--pending, .state--paused { color: var(--paused); }

.bars { display: flex; gap: 2px; height: 34px; }
.bar { position: relative; flex: 1 1 0; min-width: 0; border-radius: 2px; background: var(--empty); outline: none; }
.bar--up { background: var(--up); }
.bar--degraded { background: var(--degraded); }
.bar--down { background: var(--down); }
.bar--empty { background: var(--empty); }
.bar:hover, .bar:focus { filter: brightness(0.85); }
.bar::after {
    content: attr(data-tip);
    position: absolute; bottom: calc(100% + 8px); left: 50%; z-index: 2;
    transform: translateX(-50%);
    padding: 6px 9px; border-radius: 6px;
    background: var(--tip-bg); color: var(--tip-ink);
    font-size: 12px; line-height: 1.3; white-space: nowrap;
    pointer-events: none; opacity: 0; visibility: hidden;
    transition: opacity 0.12s;
}
.bar:hover::after, .bar:focus::after { opacity: 1; visibility: visible; }
.bar:nth-child(-n + 12)::after { left: 0; transform: none; }
.bar:nth-last-child(-n + 12)::after { left: auto; right: 0; transform: none; }
.service-foot { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--muted); }
.service-foot .ratio { color: var(--ink); font-weight: 600; }
.span-30 { display: none; }

.latency { display: flex; align-items: center; gap: 12px; margin-top: 12px; font-size: 12px; color: var(--muted); }
.latency svg { flex: 1 1 auto; min-width: 0; height: 30px; overflow: visible; }
.latency path { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.latency strong { color: var(--ink); }
.cadence { margin: 8px 0 0; font-size: 12px; color: var(--muted); }

.incidents, .history { margin: 0; padding: 0; list-style: none; }
.incidents li, .history li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; padding: 10px 0; border-top: 1px solid var(--line); }
.incidents li:first-child, .history li:first-child { padding-top: 0; border-top: 0; }
.incidents li:last-child, .history li:last-child { padding-bottom: 0; }
.incident-name { font-weight: 600; overflow-wrap: anywhere; }
.incident-meta, .history time { color: var(--muted); }
.history time { font-variant-numeric: tabular-nums; }
.empty { margin: 0; color: var(--muted); }

.foot { margin-top: 28px; text-align: center; font-size: 12px; color: var(--muted); }
.foot a { color: inherit; font-weight: 600; text-decoration: none; }
.foot a:hover, .foot a:focus-visible { text-decoration: underline; }
.missing { padding: 64px 0 32px; text-align: center; }
.missing h1 { margin: 0 0 8px; font-size: 24px; }
.missing p { margin: 0; color: var(--muted); }

@media (max-width: 600px) {
    .page { padding-top: 28px; }
    .top h1 { font-size: 23px; }
    .bar:nth-child(-n + 60) { display: none; }
    .bar:nth-child(-n + 72)::after { left: 0; transform: none; }
    .span-90 { display: none; }
    .span-30 { display: inline; }
}
@media (prefers-reduced-motion: reduce) {
    .bar::after { transition: none; }
}
`;
