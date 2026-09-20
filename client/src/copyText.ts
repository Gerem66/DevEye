/**
 * Copie `value` dans le presse-papiers et dit si ça a pris : à `false`, le geste
 * reste à confirmer autrement, jamais à taire. `navigator.clipboard` n'existe
 * qu'en contexte sécurisé (HTTPS ou localhost), d'où le repli par sélection
 * invisible, seule voie qu'une instance servie en clair garde.
 */
export async function copyText(value: string): Promise<boolean> {
    if (navigator.clipboard) {
        try {
            await navigator.clipboard.writeText(value);
            return true;
        } catch {
            // Permission refusée, ou document sans le focus : le repli reste jouable.
        }
    }
    return selectionCopy(value);
}

function selectionCopy(value: string): boolean {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.tabIndex = -1;
    // Hors champ mais rendu : une sélection ne se fait pas sur un élément absent
    // de la mise en page. `position: fixed` évite en prime de faire défiler.
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    try {
        area.select();
        area.setSelectionRange(0, value.length);
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        area.remove();
    }
}
