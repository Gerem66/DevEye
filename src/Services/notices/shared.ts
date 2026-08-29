/** Ce que toutes les mises en page Discord partagent. */

/** Couleurs de la charte Discord : la bordure dit l'état avant la lecture. */
export const COLOR_DANGER = 0xed4245;
export const COLOR_SUCCESS = 0x57f287;
export const COLOR_INFO = 0x5865f2;
export const COLOR_WARNING = 0xfee75c;

/** Discord refuse la valeur d'un champ au-delà de 1024 caractères. */
export const FIELD_MAX = 1000;

/**
 * Un instant, rendu par Discord dans le fuseau du lecteur : `:R` (« il y a
 * 4 minutes ») se met à jour tout seul.
 */
export function moment(epochSeconds: number, style: 'f' | 'R' | 'T' = 'f'): string {
    return `<t:${epochSeconds}:${style}>`;
}

/** « 3 j 02 h », « 2 h 05 min », « 45 s ». */
export function duration(seconds: number): string {
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
    return `${Math.floor(hours / 24)} j ${String(hours % 24).padStart(2, '0')} h`;
}

/** Discord refuse une valeur de champ vide : un tiret vaut mieux qu'un rejet. */
export function trim(value: string): string {
    const clean = value.trim().slice(0, FIELD_MAX);
    return clean.length > 0 ? clean : '—';
}

/**
 * Un texte quelconque, en bloc de code : rendue en Markdown, une erreur
 * arriverait à moitié en gras et à moitié en titre. Les triples accents graves
 * sont neutralisés, sinon ils refermeraient le bloc au milieu.
 */
export function block(body: string): string {
    const clean = body.replace(/```/g, "'''").trim();
    const room = FIELD_MAX - 10;
    return `\`\`\`\n${clean.length > room ? `${clean.slice(0, room)}…` : clean}\n\`\`\``;
}

/** Le pied de page commun : d'où vient ce message, et pour quoi. */
export function footer(text: string): { text: string } {
    return { text: `DevEye · ${text}` };
}
