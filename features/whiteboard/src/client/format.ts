/** Depuis quand un tableau a bougé : « à l’instant », « il y a 3 h », « le 4 novembre ». */
export function sinceLabel(seconds: number): string {
    const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
    if (elapsed < 60) return 'à l’instant';
    if (elapsed < 3600) return `il y a ${Math.floor(elapsed / 60)} min`;
    if (elapsed < 86_400) return `il y a ${Math.floor(elapsed / 3600)} h`;
    return `le ${new Date(seconds * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
}

export const updatedLabel = (seconds: number): string => `Modifié ${sinceLabel(seconds)}`;

/** Le dépôt d'origine de l'éditeur, que la grille et le menu de l'éditeur citent. */
export const EXCALIDRAW_SOURCE = 'https://github.com/excalidraw/excalidraw';
