import fontkit from '@cantoo/fontkit';
import {
    BlendMode,
    degrees,
    EncryptedPDFError,
    LineCapStyle,
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFObjectCopier,
    PDFPage,
    PDFRef,
    rgb,
    StandardFonts,
    type PDFFont,
    type PDFImage,
    type PDFObject
} from '@cantoo/pdf-lib';

import {
    HIGHLIGHT,
    HIGHLIGHT_OPACITY,
    INK,
    MARK_BOX,
    MARK_PATHS,
    rectOf,
    replicate,
    TEXT_LINE_HEIGHT,
    type InkColor,
    type PdfElement
} from './elements';
import { frameSize, toUser, userRect, type Frame, type Rect } from './geometry';
import { imagePageSize, rotateBy, type PageBox, type PlanPage } from './model';

/**
 * L'assemblage du document : les pages du plan copiées depuis leurs fichiers
 * dans un PDF neuf, ce qui est posé dessus dessiné par pdf-lib. Tourne dans un
 * worker, sans rien du DOM ; se teste sous Node.
 */

export interface BuildSource {
    id: string;
    bytes: Uint8Array;
    password: string | null;
}

export interface BuildImage {
    id: string;
    bytes: Uint8Array;
    mime: 'image/png' | 'image/jpeg';
    width: number;
    height: number;
}

/** Une image posée sur une page (signature importée, image), jamais une page. */
export interface BuildAsset {
    id: string;
    bytes: Uint8Array;
    mime: 'image/png' | 'image/jpeg';
}

/**
 * Une page caviardée, telle que l'écran l'a dessinée : ce qui est sous les
 * rectangles noirs n'existe plus, puisque la page devient cette image.
 * `width` et `height` sont ceux de la page produite, en points.
 */
export interface BuildRedaction {
    pageId: string;
    bytes: Uint8Array;
    mime: 'image/png' | 'image/jpeg';
    width: number;
    height: number;
}

/** Les polices à embarquer ; `null` : Helvetica prend le relais, sans les caractères hors Latin-1. */
export interface BuildFonts {
    sans: Uint8Array | null;
    hand: Uint8Array | null;
}

export interface BuildInput {
    sources: readonly BuildSource[];
    images: readonly BuildImage[];
    pages: readonly PlanPage[];
    elements?: readonly PdfElement[];
    assets?: readonly BuildAsset[];
    fonts?: BuildFonts;
    redactions?: readonly BuildRedaction[];
}

export type BuildProgress = (done: number, total: number) => void;

export type BuildFailureCode = 'empty' | 'password' | 'corrupt' | 'image';

export class BuildFailure extends Error {
    constructor(
        readonly code: BuildFailureCode,
        message: string
    ) {
        super(message);
    }
}

interface Loaded {
    doc: PDFDocument;
    /** Un seul copieur par fichier : ce qu'il a déjà copié est partagé entre pages et formulaire. */
    copier: PDFObjectCopier;
}

/** Une page produite, avec le cadre dans lequel ses éléments se placent. */
interface Output {
    plan: PlanPage;
    page: PDFPage;
    frame: Frame;
    /** Déjà une image : les caviardages sont dedans, rien à redessiner. */
    rasterised: boolean;
}

const ACRO_FORM = PDFName.of('AcroForm');

const acroFormOf = (doc: PDFDocument): PDFDict | undefined => doc.catalog.lookupMaybe(ACRO_FORM, PDFDict);

async function loadSource(source: BuildSource): Promise<PDFDocument> {
    try {
        // Un mot de passe vide ouvre un PDF qui n'a qu'un mot de passe de propriétaire.
        return await PDFDocument.load(source.bytes, { password: source.password ?? '', updateMetadata: false });
    } catch (e) {
        if (e instanceof EncryptedPDFError || (e instanceof Error && /password/i.test(e.message))) {
            throw new BuildFailure('password', 'Le mot de passe de ce PDF n’est plus accepté.');
        }
        throw new BuildFailure('corrupt', 'Un des PDF ne se lit plus : il est peut-être abîmé.');
    }
}

/** Les champs deviennent du contenu. Un formulaire que pdf-lib ne sait pas figer part en entier. */
function flattenForm(doc: PDFDocument): void {
    try {
        doc.getForm().flatten({ updateFieldAppearances: false });
    } catch {
        doc.catalog.delete(ACRO_FORM);
    }
}

/**
 * Un champ posé sur une page écartée désigne cette page (`/P`) : copié avec le
 * formulaire, il l'emporterait entière dans le document produit. On lui retire
 * ce lien, que le lecteur n'exige pas.
 */
function detachWidgetsOff(doc: PDFDocument, kept: ReadonlySet<number>): void {
    const keptRefs = new Set(doc.getPages().flatMap((p, i) => (kept.has(i) ? [p.ref.toString()] : [])));
    try {
        for (const field of doc.getForm().getFields()) {
            for (const widget of field.acroField.getWidgets()) {
                const page = widget.P();
                if (page && !keptRefs.has(page.toString())) widget.dict.delete(PDFName.of('P'));
            }
        }
    } catch {
        // Un formulaire illisible : il n'a de toute façon rien à garder.
    }
}

/** Le champ, ou un de ses descendants, est un widget d'une page copiée. */
function reaches(doc: PDFDocument, entry: PDFObject, onPages: ReadonlySet<string>, depth: number): boolean {
    if (onPages.has(entry.toString())) return true;
    if (depth > 6 || !(entry instanceof PDFRef)) return false;
    const kids = doc.context.lookupMaybe(entry, PDFDict)?.lookupMaybe(PDFName.of('Kids'), PDFArray);
    return kids ? kids.asArray().some((kid) => reaches(doc, kid, onPages, depth + 1)) : false;
}

/**
 * `copyPages` de pdf-lib laisse le formulaire derrière : les cases restent
 * dessinées, plus rien ne se remplit. Le même copieur copie ici le dictionnaire
 * du formulaire, dont les champs retrouvent les widgets déjà copiés avec leurs
 * pages ; ceux dont aucune page n'est gardée sont retirés de la liste.
 */
function copyAcroForm(dst: PDFDocument, { doc, copier }: Loaded): void {
    const acro = acroFormOf(doc);
    if (!acro) return;
    const copy = copier.copy(acro);
    // Un formulaire XFA ne se remplit pas ici ; ses champs classiques, si.
    copy.delete(PDFName.of('XFA'));
    const onPages = new Set<string>();
    for (const page of dst.getPages()) {
        const annots = page.node.Annots();
        if (!annots) continue;
        for (let i = 0; i < annots.size(); i++) onPages.add(annots.get(i).toString());
    }
    const fields = copy.lookupMaybe(PDFName.of('Fields'), PDFArray);
    if (fields) {
        const kept = fields.asArray().filter((entry) => reaches(dst, entry, onPages, 0));
        copy.set(PDFName.of('Fields'), dst.context.obj(kept));
    }
    dst.catalog.set(ACRO_FORM, dst.context.register(copy));
}

/** Le cadre d'une page produite : sa boîte visible (comme pdf.js la calcule) et sa rotation. */
function frameOf(page: PDFPage): Frame {
    const media = page.getMediaBox();
    const crop = page.getCropBox();
    const x1 = Math.max(media.x, crop.x);
    const y1 = Math.max(media.y, crop.y);
    const x2 = Math.min(media.x + media.width, crop.x + crop.width);
    const y2 = Math.min(media.y + media.height, crop.y + crop.height);
    const view: PageBox =
        x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : [media.x, media.y, media.x + media.width, media.y + media.height];
    return { view, rotation: rotateBy(page.getRotation().angle, 0) };
}

/** Ce dont le dessin des éléments a besoin, embarqué une fois par document. */
class Drawing {
    private sans: PDFFont | null | undefined;
    private hand: PDFFont | null | undefined;
    private fallback: PDFFont | undefined;
    private readonly embedded = new Map<string, PDFImage>();

    constructor(
        private readonly dst: PDFDocument,
        private readonly fonts: BuildFonts,
        private readonly assets: ReadonlyMap<string, BuildAsset>
    ) {
        dst.registerFontkit(fontkit);
    }

    /** La police demandée, ou Helvetica quand elle manque ; `standard` dit laquelle on a eue. */
    async font(hand: boolean): Promise<{ font: PDFFont; standard: boolean }> {
        const bytes = hand ? this.fonts.hand : this.fonts.sans;
        const cached = hand ? this.hand : this.sans;
        let font = cached;
        if (font === undefined) {
            font = bytes ? await this.dst.embedFont(bytes, { subset: true }).catch(() => null) : null;
            if (hand) this.hand = font;
            else this.sans = font;
        }
        if (font) return { font, standard: false };
        this.fallback ??= await this.dst.embedFont(StandardFonts.Helvetica);
        return { font: this.fallback, standard: true };
    }

    async asset(id: string): Promise<PDFImage | null> {
        const hit = this.embedded.get(id);
        if (hit) return hit;
        const asset = this.assets.get(id);
        if (!asset) return null;
        try {
            const image =
                asset.mime === 'image/png'
                    ? await this.dst.embedPng(asset.bytes)
                    : await this.dst.embedJpg(asset.bytes);
            this.embedded.set(id, image);
            return image;
        } catch {
            return null;
        }
    }
}

const ink = (color: InkColor) => rgb(...INK[color].rgb);

/** Helvetica n'écrit que le Latin-1 : le reste devient un point d'interrogation plutôt qu'une erreur. */
const latin1 = (text: string): string => text.replace(/[^\u0000-ÿ]/g, '?');

async function drawText(
    page: PDFPage,
    frame: Frame,
    rect: Rect,
    text: string,
    size: number,
    color: InkColor,
    hand: boolean,
    drawing: Drawing
): Promise<void> {
    const { font, standard } = await drawing.font(hand);
    // La ligne de base de la première ligne, dans le cadre affiché, puis dans le fichier.
    const baseline = toUser(frame, { x: rect.x, y: rect.y + size * 0.9 });
    page.drawText(standard ? latin1(text) : text, {
        x: baseline.x,
        y: baseline.y,
        size,
        font,
        color: ink(color),
        lineHeight: size * TEXT_LINE_HEIGHT,
        rotate: degrees(frame.rotation)
    });
}

/** Un tracé SVG (y vers le bas) posé par son coin haut-gauche affiché, à l'échelle de la boîte. */
function drawPath(
    page: PDFPage,
    frame: Frame,
    rect: Rect,
    path: string,
    natural: { width: number; height: number },
    color: InkColor,
    stroke: number
): void {
    const scale = rect.width / Math.max(natural.width, 0.01);
    const origin = toUser(frame, { x: rect.x, y: rect.y });
    page.drawSvgPath(path, {
        x: origin.x,
        y: origin.y,
        scale,
        rotate: degrees(frame.rotation),
        borderColor: ink(color),
        // L'épaisseur se donne dans les unités du tracé, que l'échelle multiplie ensuite.
        borderWidth: stroke / scale,
        borderLineCap: LineCapStyle.Round
    });
}

async function drawImage(page: PDFPage, frame: Frame, rect: Rect, assetId: string, drawing: Drawing): Promise<void> {
    const image = await drawing.asset(assetId);
    if (!image) return;
    const corner = toUser(frame, { x: rect.x, y: rect.y + rect.height });
    page.drawImage(image, {
        x: corner.x,
        y: corner.y,
        width: rect.width,
        height: rect.height,
        rotate: degrees(frame.rotation)
    });
}

async function drawElement(out: Output, rect: Rect, el: PdfElement, drawing: Drawing): Promise<void> {
    const { page, frame } = out;
    switch (el.kind) {
        case 'text':
            await drawText(page, frame, rect, el.text, el.size, el.color, el.hand, drawing);
            break;
        case 'signature':
            switch (el.signature.kind) {
                case 'path':
                    drawPath(page, frame, rect, el.signature.path, el.signature, el.color, el.signature.stroke);
                    break;
                case 'text':
                    await drawText(
                        page,
                        frame,
                        rect,
                        el.signature.text,
                        rect.height / TEXT_LINE_HEIGHT,
                        el.color,
                        true,
                        drawing
                    );
                    break;
                case 'image':
                    await drawImage(page, frame, rect, el.signature.assetId, drawing);
                    break;
            }
            break;
        case 'mark':
            drawPath(
                page,
                frame,
                rect,
                MARK_PATHS[el.mark],
                { width: MARK_BOX, height: MARK_BOX },
                el.color,
                2.5 * (rect.width / MARK_BOX)
            );
            break;
        case 'image':
            await drawImage(page, frame, rect, el.assetId, drawing);
            break;
        case 'highlight':
            page.drawRectangle({
                ...userRect(frame, rect),
                color: rgb(...HIGHLIGHT[el.color].rgb),
                opacity: HIGHLIGHT_OPACITY,
                blendMode: BlendMode.Multiply
            });
            break;
        case 'box':
            if (el.fill === 'none' && el.border === null) break;
            page.drawRectangle({
                ...userRect(frame, rect),
                color: el.fill === 'white' ? rgb(1, 1, 1) : undefined,
                borderColor: el.border ? ink(el.border) : undefined,
                borderWidth: el.border ? 1.2 : 0
            });
            break;
        case 'ink':
            drawPath(page, frame, rect, el.path, { width: el.pathWidth, height: el.pathHeight }, el.color, el.stroke);
            break;
        case 'redact':
            // Sans image de la page, le rectangle noir couvre ; avec, le texte dessous a déjà disparu.
            if (!out.rasterised) page.drawRectangle({ ...userRect(frame, rect), color: rgb(0, 0, 0) });
            break;
    }
}

export async function buildPdf(input: BuildInput, onProgress: BuildProgress = () => undefined): Promise<Uint8Array> {
    if (input.pages.length === 0) throw new BuildFailure('empty', 'Aucune page à produire.');
    const dst = await PDFDocument.create();

    const used = new Set(input.pages.flatMap((p) => (p.kind === 'source' ? [p.sourceId] : [])));
    const loaded = new Map<string, Loaded>();
    for (const source of input.sources) {
        if (!used.has(source.id)) continue;
        const doc = await loadSource(source);
        loaded.set(source.id, { doc, copier: PDFObjectCopier.for(doc.context, dst.context) });
    }

    // Les champs d'un seul fichier restent remplissables. Deux formulaires ne se
    // fondent pas en un (noms de champs, polices) : venus de plusieurs fichiers,
    // ils sont figés en contenu.
    const withForm = [...loaded.entries()].filter(([, l]) => acroFormOf(l.doc) !== undefined);
    const formOwner = withForm.length === 1 ? withForm[0][0] : null;
    for (const [id, l] of withForm) {
        if (id === formOwner) {
            const kept = new Set(
                input.pages.flatMap((p) => (p.kind === 'source' && p.sourceId === id ? [p.index] : []))
            );
            detachWidgetsOff(l.doc, kept);
        } else {
            flattenForm(l.doc);
        }
    }
    for (const l of loaded.values()) await l.doc.flush();

    const redactions = new Map((input.redactions ?? []).map((r) => [r.pageId, r]));
    const embedded = new Map<string, PDFImage>();
    const embed = async (id: string, bytes: Uint8Array, mime: 'image/png' | 'image/jpeg'): Promise<PDFImage> => {
        let image = embedded.get(id);
        if (!image) {
            try {
                image = mime === 'image/png' ? await dst.embedPng(bytes) : await dst.embedJpg(bytes);
            } catch {
                throw new BuildFailure('image', 'Une image du document ne se lit pas.');
            }
            embedded.set(id, image);
        }
        return image;
    };

    const outputs: Output[] = [];
    const total = input.pages.length;
    for (const [i, page] of input.pages.entries()) {
        const raster = redactions.get(page.id);
        if (raster) {
            const added = dst.addPage([raster.width, raster.height]);
            const image = await embed(`redaction:${page.id}`, raster.bytes, raster.mime);
            added.drawImage(image, { x: 0, y: 0, width: raster.width, height: raster.height });
            outputs.push({
                plan: page,
                page: added,
                frame: { view: [0, 0, raster.width, raster.height], rotation: 0 },
                rasterised: true
            });
            onProgress(i + 1, total);
            continue;
        }
        switch (page.kind) {
            case 'source': {
                const l = loaded.get(page.sourceId);
                if (!l || page.index >= l.doc.getPageCount()) {
                    throw new BuildFailure('corrupt', 'Une page du plan ne se trouve plus dans son fichier.');
                }
                const copied = l.copier.copy(l.doc.getPage(page.index).node);
                const added = dst.addPage(PDFPage.of(copied, dst.context.register(copied), dst));
                added.setRotation(degrees(rotateBy(added.getRotation().angle, page.rotation)));
                outputs.push({ plan: page, page: added, frame: frameOf(added), rasterised: false });
                break;
            }
            case 'blank': {
                const added = dst.addPage([page.width, page.height]);
                added.setRotation(degrees(page.rotation));
                outputs.push({ plan: page, page: added, frame: frameOf(added), rasterised: false });
                break;
            }
            case 'image': {
                const image = input.images.find((img) => img.id === page.imageId);
                if (!image) throw new BuildFailure('image', 'Une image du document manque.');
                const embedded = await embed(image.id, image.bytes, image.mime);
                const size = imagePageSize(image);
                const added = dst.addPage([size.width, size.height]);
                added.drawImage(embedded, { x: 0, y: 0, width: size.width, height: size.height });
                added.setRotation(degrees(page.rotation));
                outputs.push({ plan: page, page: added, frame: frameOf(added), rasterised: false });
                break;
            }
        }
        onProgress(i + 1, total);
    }

    const owner = formOwner === null ? undefined : loaded.get(formOwner);
    if (owner) copyAcroForm(dst, owner);

    const elements = input.elements ?? [];
    if (elements.length > 0) {
        const drawing = new Drawing(
            dst,
            input.fonts ?? { sans: null, hand: null },
            new Map((input.assets ?? []).map((a) => [a.id, a]))
        );
        const byPage = new Map(outputs.map((o) => [o.plan.id, o]));
        for (const out of outputs) {
            const size = frameSize(out.frame);
            for (const el of elements) {
                const own = el.pageId === out.plan.id;
                if (!own && !el.everyPage) continue;
                if (!own && el.kind === 'redact') continue;
                if (out.rasterised && el.kind === 'redact') continue;
                const origin = byPage.get(el.pageId);
                const rect = own ? rectOf(el) : replicate(rectOf(el), origin ? frameSize(origin.frame) : size, size);
                await drawElement(out, rect, el, drawing);
            }
        }
    }

    return dst.save();
}
