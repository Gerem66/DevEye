/**
 * Ce que toutes les mises en page Discord partagent.
 *
 * Il existait deux jeux de ces helpers — un dans `UptimeNotice`, un dans
 * `DeployNotice` — recopiés à quelques mots près, et l'un d'eux avait **dérivé** :
 * `duration()` traitait les jours côté Uptime et s'arrêtait aux heures côté
 * Déploiement, si bien qu'une panne de trois jours se lisait « 72 h » d'un côté
 * et « 3 j » de l'autre. C'est exactement le genre d'écart qu'une copie garantit
 * et qu'on ne découvre que le jour où il se voit.
 *
 * Les trois émetteurs qui n'avaient aucune mise en page — Sentinelle, Bases de
 * données, Sauvegardes — s'appuient dessus dès le premier jour, ce qui est la
 * vraie raison de l'extraire maintenant plutôt que de la laisser en double.
 */

/** Couleurs de la charte Discord : la bordure dit l'état avant la lecture. */
export const COLOR_DANGER = 0xed4245;
export const COLOR_SUCCESS = 0x57f287;
export const COLOR_INFO = 0x5865f2;
export const COLOR_WARNING = 0xfee75c;

/** Discord refuse la valeur d'un champ au-delà de 1024 caractères. */
export const FIELD_MAX = 1000;

/**
 * Un instant, rendu par Discord dans le fuseau **du lecteur**.
 *
 * `<t:epoch:f>` plutôt qu'une date que nous formaterions ici : le message reste
 * juste pour qui le lit d'un autre fuseau, et `:R` (« il y a 4 minutes ») se met
 * à jour tout seul, ce qu'aucune chaîne figée ne sait faire — y compris entre
 * deux modifications d'un même message de suivi.
 */
export function moment(epochSeconds: number, style: 'f' | 'R' | 'T' = 'f'): string {
    return `<t:${epochSeconds}:${style}>`;
}

/**
 * « 3 j 02 h », « 2 h 05 min », « 45 s ».
 *
 * L'échelle va jusqu'aux **jours** : c'était la version d'Uptime, et c'est la
 * bonne. Celle du déploiement s'arrêtait aux heures, ce qui n'avait pas d'effet
 * visible tant qu'aucun déploiement ne durait un jour — une hypothèse, pas une
 * garantie.
 */
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
 * Un texte quelconque, en bloc de code.
 *
 * Le bloc n'est pas décoratif : une erreur vient d'un point d'entrée quelconque
 * et peut contenir n'importe quoi — des `*`, des `_`, un `#` en début de ligne.
 * Rendue en Markdown, elle arriverait à moitié en gras et à moitié en titre. Le
 * code la montre telle qu'elle est.
 *
 * Les triples accents graves du contenu sont neutralisés : sans ça, un journal
 * qui en contient referme le bloc au milieu et le reste du message part en
 * Markdown.
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
