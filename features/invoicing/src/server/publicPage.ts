import { DEVEYE_ICON_PATH } from '@deveye/types/sdk';

import { escapeHtml, renderPaper, type PaperInput } from './paper';

/**
 * La page que le client ouvre, sans compte et sans un octet de JavaScript : le
 * formulaire de réponse est un `<form method="post">` ordinaire, que le socle
 * sait lire. C'est ce qui évite d'avoir à desserrer quoi que ce soit du côté des
 * scripts, et ce qui fait qu'elle marche partout.
 */

const ANSWER_PATH = '/api/invoicing/answer';

const FORM_STYLE = `
    .accept { margin-top: 10mm; padding: 5mm; border: 1pt solid var(--rule); background: var(--band);
              break-inside: avoid; }
    .accept h2 { margin-bottom: 3mm; }
    .accept label { display: block; margin-bottom: 2mm; color: var(--muted); font-size: 9.5pt; }
    .accept input[type=text] { width: 100%; max-width: 80mm; padding: 2.5mm; border: 1pt solid var(--rule);
                               border-radius: 2mm; font: inherit; }
    .accept .answers { display: flex; flex-wrap: wrap; gap: 4mm; align-items: center; margin-top: 4mm; }
    .accept button { padding: 2.5mm 6mm; border: 1pt solid var(--ink); border-radius: 2mm;
                     background: var(--ink); color: #fff; font: inherit; cursor: pointer; }
    .accept .decline { background: none; color: var(--muted); border-color: var(--rule); }
    .accept .fine { margin-top: 3mm; color: var(--faint); font-size: 8.5pt; }
    /* Les deux voies ne paraissent jamais ensemble : le formulaire vaut à l'écran,
       où l'on répond d'un clic, et le cadre manuscrit vaut sur le papier, où l'on
       ne clique pas. Un devis déjà répondu n'a ni l'un ni l'autre. */
    @media print { .accept { display: none; } }
    @media screen { .sign { display: none; } }
`;

/**
 * Le bloc de réponse, ajouté au document quand le devis attend encore. Les deux
 * réponses sont là : offrir l'accord seul obligerait un client qui refuse à
 * écrire un courriel, et l'émetteur ne saurait jamais où il en est. Le refus
 * n'exige pas le nom (`formnovalidate`) : on ne fait pas signer un refus.
 */
export function answerForm(token: string, signatureText: string): string {
    return `<section class="accept">
    <h2>Votre réponse</h2>
    <form method="post" action="${ANSWER_PATH}">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <label for="signer">${escapeHtml(signatureText)}</label>
        <input id="signer" name="name" type="text" maxlength="160" required placeholder="Vos nom et prénom">
        <div class="answers">
            <button type="submit" name="answer" value="accept">J’accepte ce devis</button>
            <button type="submit" name="answer" value="decline" class="decline" formnovalidate>Je refuse</button>
        </div>
    </form>
    <p class="fine">Votre réponse sera horodatée et transmise à l’émetteur. Un accord vaut bon pour accord, et non
    signature électronique qualifiée.</p>
</section>`;
}

/** La page complète : le document, et le bloc de réponse s'il y a lieu. */
/** L'icône d'onglet, celle de DevEye : le papier imprimé n'en a pas besoin, la page en ligne si. */
const ICON_LINK = `<link rel="icon" href="${DEVEYE_ICON_PATH}">`;

export function renderPublicPage(input: PaperInput, form: string | null): string {
    const html = renderPaper({ ...input, extra: form ?? '' }).replace('</head>', `${ICON_LINK}\n</head>`);
    return form === null ? html : html.replace('</style>', `${FORM_STYLE}</style>`);
}

/** Ce que voit qui suit un lien périmé : une phrase, et rien du reste. */
export function renderMissingPage(): string {
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Document introuvable</title>
${ICON_LINK}
<style>
    body { margin: 0; display: grid; place-items: center; min-height: 100vh; background: #f6f8fa; color: #14181d;
           font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
    main { max-width: 32rem; padding: 2rem; text-align: center; }
    h1 { font-size: 1.25rem; }
    p { color: #5b6672; line-height: 1.5; }
</style>
</head>
<body>
<main>
    <h1>Ce document n’est plus accessible</h1>
    <p>Le lien a peut-être été révoqué, ou le document retiré. Demandez-en un nouveau à la personne qui vous l’a
    envoyé.</p>
</main>
</body>
</html>`;
}
