/**
 * L'impression : le document part dans une iframe cachée, et c'est la boîte
 * d'impression du navigateur qui offre « Enregistrer au format PDF ». Aucune
 * dépendance, du texte réellement sélectionnable, et la même chaîne HTML que
 * l'aperçu et que la page publique.
 *
 * C'est la mécanique de l'export des Notes, à une chose près : le document est
 * construit par le serveur, pas ici.
 *
 * Limite connue, à dire plutôt qu'à contourner : les boîtes de marge de `@page`
 * (donc le numéro de page) ne sont honorées que par Chrome et Safari récents.
 * Une impression depuis Firefox n'aura pas de numéro de page.
 */
export function printDocument(html: string): void {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(iframe);

    const win = iframe.contentWindow;
    if (win === null) {
        iframe.remove();
        return;
    }

    win.document.open();
    win.document.write(html);
    win.document.close();

    // Le temps que la mise en page se fasse : imprimer trop tôt donne une page
    // blanche sur les documents qui portent un logo.
    window.setTimeout(() => {
        win.focus();
        win.print();
        window.setTimeout(() => iframe.remove(), 1000);
    }, 250);
}
