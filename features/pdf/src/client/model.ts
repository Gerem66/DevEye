/**
 * L'état de l'atelier PDF, en données pures : des fichiers sources, des images
 * devenues pages, et le plan des pages du document à produire. Rien d'ici ne
 * touche à pdf.js ni à pdf-lib : tout se teste sous Node.
 */

export type Rotation = 0 | 90 | 180 | 270;

export const rotateBy = (rotation: number, delta: number): Rotation =>
    ((((Math.round(rotation / 90) * 90 + delta) % 360) + 360) % 360) as Rotation;

/** Le rectangle d'une page tel que pdf.js le donne (`view`) : x1, y1, x2, y2 en points, dans l'espace du fichier. */
export type PageBox = readonly [number, number, number, number];

/** Ce que le fichier dit d'une page : sa boîte, et la rotation qu'il lui donne déjà. */
export interface PageGeometry {
    view: PageBox;
    rotate: Rotation;
}

export interface Size {
    width: number;
    height: number;
}

/** Le nombre de couleurs qui distinguent les fichiers à l'écran (`--palette-*`). */
export const SOURCE_COLORS = 8;

export interface SourceInfo {
    id: string;
    name: string;
    bytes: number;
    pages: readonly PageGeometry[];
    /** Ouvert avec un mot de passe. Le document produit n'en a pas, sauf à en poser un. */
    protectedByPassword: boolean;
    /** Des champs à remplir. */
    hasForm: boolean;
    /** Un formulaire XFA seul : rien que l'atelier sache remplir. */
    pureXfa: boolean;
    /** L'index de la couleur qui désigne ce fichier dans l'atelier. */
    color: number;
    /** Ce que le fichier dit de lui : proposé pour le document produit. */
    meta: { title: string; author: string; subject: string };
}

export interface ImageInfo {
    id: string;
    name: string;
    width: number;
    height: number;
    mime: 'image/png' | 'image/jpeg';
}

export type PlanPage =
    | { id: string; kind: 'source'; sourceId: string; index: number; rotation: Rotation }
    | { id: string; kind: 'blank'; width: number; height: number; rotation: Rotation }
    | { id: string; kind: 'image'; imageId: string; rotation: Rotation };

export interface Plan {
    sources: readonly SourceInfo[];
    images: readonly ImageInfo[];
    pages: readonly PlanPage[];
}

export const EMPTY_PLAN: Plan = { sources: [], images: [], pages: [] };

let seq = 0;
export const newId = (): string => `p${++seq}`;

export const A4: Size = { width: 595.28, height: 841.89 };

/** Une page faite d'une image a le côté long d'un A4 : des pages de même taille, quelle que soit la photo. */
export function imagePageSize(image: Size): Size {
    const scale = A4.height / Math.max(image.width, image.height, 1);
    return { width: image.width * scale, height: image.height * scale };
}

export const sourceOf = (plan: Plan, id: string): SourceInfo | undefined => plan.sources.find((s) => s.id === id);
export const imageOf = (plan: Plan, id: string): ImageInfo | undefined => plan.images.find((i) => i.id === id);

/** La taille d'une page avant toute rotation. */
export function nativeSize(page: PlanPage, plan: Plan): Size {
    switch (page.kind) {
        case 'source': {
            const geometry = sourceOf(plan, page.sourceId)?.pages[page.index];
            if (!geometry) return A4;
            return { width: geometry.view[2] - geometry.view[0], height: geometry.view[3] - geometry.view[1] };
        }
        case 'blank':
            return { width: page.width, height: page.height };
        case 'image': {
            const image = imageOf(plan, page.imageId);
            return image ? imagePageSize(image) : A4;
        }
    }
}

/** La rotation affichée : celle que le fichier donne à la page, plus celle de l'atelier. */
export function totalRotation(page: PlanPage, plan: Plan): Rotation {
    const own = page.kind === 'source' ? (sourceOf(plan, page.sourceId)?.pages[page.index]?.rotate ?? 0) : 0;
    return rotateBy(own, page.rotation);
}

/** La taille telle qu'elle s'affiche, rotation comprise. */
export function displayedSize(page: PlanPage, plan: Plan): Size {
    const size = nativeSize(page, plan);
    return totalRotation(page, plan) % 180 === 0 ? size : { width: size.height, height: size.width };
}

export function pagesOf(source: SourceInfo): PlanPage[] {
    return source.pages.map((_, index) => ({ id: newId(), kind: 'source', sourceId: source.id, index, rotation: 0 }));
}

function insertAt<T>(list: readonly T[], items: readonly T[], at: number | undefined): T[] {
    const index = at === undefined ? list.length : Math.max(0, Math.min(at, list.length));
    return [...list.slice(0, index), ...items, ...list.slice(index)];
}

export function addSource(plan: Plan, source: SourceInfo, at?: number): Plan {
    return { ...plan, sources: [...plan.sources, source], pages: insertAt(plan.pages, pagesOf(source), at) };
}

export function addImage(plan: Plan, image: ImageInfo, at?: number): Plan {
    const page: PlanPage = { id: newId(), kind: 'image', imageId: image.id, rotation: 0 };
    return { ...plan, images: [...plan.images, image], pages: insertAt(plan.pages, [page], at) };
}

/** Les images qu'aucune page ne montre plus quittent le plan avec leur dernière page. */
function pruneImages(plan: Plan): Plan {
    const shown = new Set(plan.pages.flatMap((p) => (p.kind === 'image' ? [p.imageId] : [])));
    const images = plan.images.filter((i) => shown.has(i.id));
    return images.length === plan.images.length ? plan : { ...plan, images };
}

export function removeSource(plan: Plan, sourceId: string): Plan {
    return {
        ...plan,
        sources: plan.sources.filter((s) => s.id !== sourceId),
        pages: plan.pages.filter((p) => p.kind !== 'source' || p.sourceId !== sourceId)
    };
}

/**
 * Les fichiers dans un nouvel ordre : chaque fichier emporte ses pages, dans
 * leur ordre actuel. Une page blanche ou une image suit la page qui la précède.
 */
export function reorderSources(plan: Plan, order: readonly string[]): Plan {
    const groups = new Map<string, PlanPage[]>(order.map((id) => [id, []]));
    let current: string | null = order[0] ?? null;
    const loose: PlanPage[] = [];
    for (const page of plan.pages) {
        if (page.kind === 'source' && groups.has(page.sourceId)) current = page.sourceId;
        const group = current === null ? null : groups.get(current);
        if (group) group.push(page);
        else loose.push(page);
    }
    const sources = order.flatMap((id) => plan.sources.filter((s) => s.id === id));
    return { ...plan, sources, pages: [...loose, ...order.flatMap((id) => groups.get(id) ?? [])] };
}

export function reorderPages(plan: Plan, order: readonly string[]): Plan {
    const byId = new Map(plan.pages.map((p) => [p.id, p]));
    const pages = order.flatMap((id) => {
        const page = byId.get(id);
        return page ? [page] : [];
    });
    if (pages.length !== plan.pages.length) return plan;
    return { ...plan, pages };
}

/**
 * Un glissé ne déplace qu'une page ; quand elle fait partie de la sélection,
 * toute la sélection la suit là où elle a atterri, dans l'ordre qu'elle avait.
 */
export function moveTogether(
    previous: readonly string[],
    order: readonly string[],
    dragged: string,
    selected: readonly string[]
): string[] {
    const chosen = new Set(selected);
    if (!chosen.has(dragged)) return [...order];
    const block = previous.filter((id) => chosen.has(id));
    const rest = order.filter((id) => !chosen.has(id) || id === dragged);
    const at = rest.indexOf(dragged);
    return [...rest.slice(0, at), ...block, ...rest.slice(at + 1)];
}

export function removePages(plan: Plan, ids: readonly string[]): Plan {
    const gone = new Set(ids);
    return pruneImages({ ...plan, pages: plan.pages.filter((p) => !gone.has(p.id)) });
}

export function keepPages(plan: Plan, ids: readonly string[]): Plan {
    const kept = new Set(ids);
    return pruneImages({ ...plan, pages: plan.pages.filter((p) => kept.has(p.id)) });
}

export function rotatePages(plan: Plan, ids: readonly string[], delta: 90 | -90 | 180): Plan {
    const chosen = new Set(ids);
    return {
        ...plan,
        pages: plan.pages.map((p) => (chosen.has(p.id) ? { ...p, rotation: rotateBy(p.rotation, delta) } : p))
    };
}

/** Chaque copie se glisse juste après son original. */
export function duplicatePages(plan: Plan, ids: readonly string[]): { plan: Plan; created: string[] } {
    const chosen = new Set(ids);
    const created: string[] = [];
    const pages = plan.pages.flatMap((p) => {
        if (!chosen.has(p.id)) return [p];
        const copy = { ...p, id: newId() };
        created.push(copy.id);
        return [p, copy];
    });
    return { plan: { ...plan, pages }, created };
}

/** Une page blanche après `afterId` (en fin sinon), à la taille affichée de sa voisine. */
export function insertBlank(plan: Plan, afterId: string | null): { plan: Plan; id: string } {
    const at = afterId === null ? -1 : plan.pages.findIndex((p) => p.id === afterId);
    const neighbour = plan.pages[at === -1 ? plan.pages.length - 1 : at];
    const size = neighbour ? displayedSize(neighbour, plan) : A4;
    const page: PlanPage = { id: newId(), kind: 'blank', width: size.width, height: size.height, rotation: 0 };
    return { plan: { ...plan, pages: insertAt(plan.pages, [page], at === -1 ? undefined : at + 1) }, id: page.id };
}

/** Les pages paires ou impaires, au sens du document produit. */
export function pagesByParity(plan: Plan, parity: 'even' | 'odd'): string[] {
    return plan.pages.filter((_, i) => (i + 1) % 2 === (parity === 'even' ? 0 : 1)).map((p) => p.id);
}

/** Les pages entre deux, dans l'ordre du plan, bornes comprises. */
export function pagesBetween(plan: Plan, a: string, b: string): string[] {
    const from = plan.pages.findIndex((p) => p.id === a);
    const to = plan.pages.findIndex((p) => p.id === b);
    if (from === -1 || to === -1) return [b];
    const [lo, hi] = from < to ? [from, to] : [to, from];
    return plan.pages.slice(lo, hi + 1).map((p) => p.id);
}

export const pagesUsing = (plan: Plan, sourceId: string): number =>
    plan.pages.filter((p) => p.kind === 'source' && p.sourceId === sourceId).length;

const plural = (count: number, one: string, many: string): string => `${count} ${count > 1 ? many : one}`;

/** « 3 fichiers · 24 pages », pour l'en-tête et le bandeau du bas. */
export function summarize(plan: Plan): string {
    const files = plan.sources.length + plan.images.length;
    if (files === 0 && plan.pages.length === 0) return 'Aucun fichier';
    return `${plural(files, 'fichier', 'fichiers')} · ${plural(plan.pages.length, 'page', 'pages')}`;
}

const stem = (name: string): string => {
    const dot = name.lastIndexOf('.');
    return (dot > 0 ? name.slice(0, dot) : name).trim() || 'document';
};

/** Le nom du fichier produit : celui du seul fichier, ou le premier et le compte des autres. */
export function outputName(plan: Plan): string {
    const names = [...plan.sources.map((s) => s.name), ...plan.images.map((i) => i.name)];
    if (names.length === 0) return 'document.pdf';
    if (names.length === 1) return `${stem(names[0])}.pdf`;
    return `${stem(names[0])} et ${plural(names.length - 1, 'autre', 'autres')}.pdf`;
}

/** Par quelle porte on entre dans l'atelier : une tuile de l'accueil, ou un dépôt de fichiers. */
export type WorkshopIntent = 'pages' | 'merge' | 'extract' | 'reorder' | 'sign' | 'form' | 'text' | 'protect';

/** Ce que le sélecteur de fichiers de l'atelier propose. Le dépôt, lui, accepte tout et trie. */
export const WORKSHOP_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif';

export const PDF_TYPE = 'application/pdf';
export const IMAGE_TYPES: readonly string[] = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/bmp',
    'image/avif'
];

export const isPdfFile = (file: { name: string; type: string }): boolean =>
    file.type === PDF_TYPE || /\.pdf$/i.test(file.name);
export const isImageFile = (file: { name: string; type: string }): boolean => IMAGE_TYPES.includes(file.type);

/** Un dépôt pour l'atelier : au moins un PDF, ou plusieurs images, et rien d'autre. */
export function routesToWorkshop(files: readonly { name: string; type: string }[]): boolean {
    if (files.length === 0) return false;
    if (!files.every((f) => isPdfFile(f) || isImageFile(f))) return false;
    return files.some(isPdfFile) || files.length > 1;
}
