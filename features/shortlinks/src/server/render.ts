import { DEVEYE_ICON_PATH } from '@deveye/types/sdk';

import { SHORTLINK_REPORT_REASON_LABELS, SHORTLINK_REPORT_REASONS } from '../contracts/domain';

/**
 * Les pages qu'un visiteur voit à la place d'une redirection : sans script,
 * sans ressource distante, en français, au vouvoiement. Elles vivent hors de
 * l'app et de son thème : leurs couleurs sont leurs propres jetons, posés une
 * fois par thème, et suivent celui du visiteur.
 */

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const LIGHT = `
    color-scheme: light;
    --bg: #f5f6f8;
    --card: #ffffff;
    --ink: #15171c;
    --muted: #5e6573;
    --line: #e3e6eb;
    --accent: #3a6ad6;
    --accent-ink: #ffffff;
    --danger: #c23434;
    --field: #ffffff;`;

const DARK = `
    color-scheme: dark;
    --bg: #0e1015;
    --card: #161920;
    --ink: #e8eaef;
    --muted: #9aa2b1;
    --line: #262b35;
    --accent: #6f9bff;
    --accent-ink: #0e1015;
    --danger: #ee6a6a;
    --field: #0e1015;`;

const STYLE = `
:root {${LIGHT}
}
@media (prefers-color-scheme: dark) {
    :root {${DARK}
    }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 24px 16px;
    background: var(--bg);
    color: var(--ink);
    font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
main {
    width: 100%;
    max-width: 480px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 28px 24px;
}
h1 { font-size: 1.25rem; margin: 0 0 8px; }
p { margin: 0 0 12px; color: var(--muted); }
p:last-child { margin-bottom: 0; }
.target {
    display: block;
    margin: 4px 0 20px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--ink);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
}
.button {
    display: inline-block;
    padding: 10px 18px;
    border: 0;
    border-radius: 8px;
    background: var(--accent);
    color: var(--accent-ink);
    font: inherit;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
}
.button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin-top: 8px; }
a { color: var(--accent); }
label { display: block; margin: 14px 0 6px; font-weight: 600; font-size: 0.95rem; }
.check { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; }
.check input { margin-top: 4px; }
input[type='password'], input[type='text'], input[type='email'], textarea, select {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--field);
    color: var(--ink);
    font: inherit;
}
textarea { min-height: 120px; resize: vertical; }
.error { color: var(--danger); font-weight: 600; }
.hp { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
footer { font-size: 0.85rem; color: var(--muted); text-align: center; }
`;

/**
 * Tout en ligne sauf l'icône d'onglet ; un formulaire ne poste que vers
 * cette adresse ; aucune page ne se laisse intégrer dans une autre, ce qui
 * déjoue un aperçu ou un formulaire de mot de passe maquillé par un tiers.
 */
export const PAGE_CSP = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
].join('; ');

export interface PageOptions {
    /** Le site vitrine, pour le pied de page ; vide sans lui. */
    siteUrl: string;
}

function footer(siteUrl: string): string {
    if (siteUrl.length === 0) return '<footer>Lien court propulsé par DevEye</footer>';
    const site = escapeHtml(siteUrl);
    return `<footer>Lien court propulsé par <a href="${site}" target="_blank" rel="noopener">DevEye</a> · <a href="${site}/confidentialite" target="_blank" rel="noopener">Confidentialité</a></footer>`;
}

function documentOf(title: string, body: string, options: PageOptions): string {
    return `<!doctype html>
<html lang="fr">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="robots" content="noindex, nofollow" />
        <meta name="referrer" content="no-referrer" />
        <title>${escapeHtml(title)}</title>
        <link rel="icon" href="${DEVEYE_ICON_PATH}" />
        <style>${STYLE}</style>
    </head>
    <body>
        <main>
            ${body}
        </main>
        ${footer(options.siteUrl)}
    </body>
</html>
`;
}

function notice(title: string, text: string, options: PageOptions): string {
    return documentOf(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`, options);
}

export const renderMissing = (options: PageOptions): string =>
    notice('Lien introuvable', 'Ce lien n’existe pas, ou n’est plus en service.', options);

export const renderExpired = (options: PageOptions): string =>
    notice('Ce lien a expiré', 'Son auteur l’a limité dans le temps ou en nombre de visites.', options);

export const renderBlocked = (options: PageOptions): string =>
    notice('Lien retiré', 'Ce lien a été retiré par l’administration du service après un signalement.', options);

export const renderUnavailable = (options: PageOptions): string =>
    notice(
        'Lien momentanément indisponible',
        'Ce lien ne peut pas vous rediriger pour l’instant. Réessayez plus tard.',
        options
    );

export const renderHome = (options: PageOptions): string =>
    notice('Liens courts', 'Cette adresse sert les liens courts créés avec DevEye.', options);

export interface PasswordPage {
    /** Où le formulaire poste : `/l/<code>/deverrouiller`. */
    action: string;
    error: boolean;
}

export function renderPassword(page: PasswordPage, options: PageOptions): string {
    const error = page.error ? '<p class="error" role="alert">Mot de passe incorrect.</p>' : '';
    return documentOf(
        'Lien protégé',
        `<h1>Lien protégé</h1>
            <p>Son auteur l’a protégé par un mot de passe. Saisissez-le pour continuer.</p>
            ${error}
            <form method="post" action="${escapeHtml(page.action)}">
                <label for="password">Mot de passe</label>
                <input id="password" name="password" type="password" autocomplete="off" required autofocus />
                <div class="row"><button class="button" type="submit">Continuer</button></div>
            </form>`,
        options
    );
}

export interface PreviewPage {
    title: string;
    /** La destination pour l'appareil du visiteur ; `null` quand un mot de passe la garde. */
    target: string | null;
    /** Le lien lui-même : le suivre redirige et compte la visite. */
    link: string;
    report: string;
}

export function renderPreview(page: PreviewPage, options: PageOptions): string {
    const heading = page.title.length > 0 ? page.title : 'Où mène ce lien ?';
    const target =
        page.target === null
            ? '<p>Ce lien est protégé par un mot de passe : sa destination ne s’affiche qu’une fois le mot de passe saisi.</p>'
            : `<p>Ce lien mène à :</p><span class="target">${escapeHtml(page.target)}</span>`;
    return documentOf(
        heading,
        `<h1>${escapeHtml(heading)}</h1>
            ${target}
            <div class="row">
                <a class="button" href="${escapeHtml(page.link)}" rel="noopener noreferrer nofollow">Ouvrir le lien</a>
                <a href="${escapeHtml(page.report)}">Signaler ce lien</a>
            </div>`,
        options
    );
}

export interface ReportForm {
    action: string;
    values: { reason: string; message: string; name: string; email: string };
    error: string | null;
}

export function renderReport(form: ReportForm, options: PageOptions): string {
    const reasons = SHORTLINK_REPORT_REASONS.map(
        (key) =>
            `<option value="${key}"${form.values.reason === key ? ' selected' : ''}>${escapeHtml(SHORTLINK_REPORT_REASON_LABELS[key])}</option>`
    ).join('');
    const error = form.error === null ? '' : `<p class="error" role="alert">${escapeHtml(form.error)}</p>`;
    return documentOf(
        'Signaler un lien',
        `<h1>Signaler ce lien</h1>
            <p>Un lien qui trompe, vole des identifiants ou mène à un contenu illicite ? L’administration du service examine chaque signalement et peut retirer le lien.</p>
            ${error}
            <form method="post" action="${escapeHtml(form.action)}">
                <label for="reason">Motif</label>
                <select id="reason" name="reason" required>
                    <option value="">Choisissez un motif</option>
                    ${reasons}
                </select>
                <label for="message">Ce qui pose problème</label>
                <textarea id="message" name="message" required minlength="10" maxlength="4000">${escapeHtml(form.values.message)}</textarea>
                <label for="name">Votre nom</label>
                <input id="name" name="name" type="text" autocomplete="name" required maxlength="120" value="${escapeHtml(form.values.name)}" />
                <label for="email">Votre adresse e-mail</label>
                <input id="email" name="email" type="email" autocomplete="email" required maxlength="200" value="${escapeHtml(form.values.email)}" />
                <div class="hp" aria-hidden="true"><label for="hp">Laissez ce champ vide</label><input id="hp" name="_hp" type="text" tabindex="-1" autocomplete="off" /></div>
                <label class="check"><input type="checkbox" name="goodFaith" required /> Je déclare de bonne foi que ces informations sont exactes.</label>
                <div class="row"><button class="button" type="submit">Envoyer le signalement</button></div>
            </form>`,
        options
    );
}

export function renderReportDone(ref: string, options: PageOptions): string {
    return documentOf(
        'Signalement envoyé',
        `<h1>Signalement envoyé</h1>
            <p>Merci. L’administration du service va l’examiner.</p>
            <p>Référence : <strong>${escapeHtml(ref)}</strong></p>`,
        options
    );
}
