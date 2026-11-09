import {
    degrees,
    EncryptedPDFError,
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFObjectCopier,
    PDFPage,
    PDFRef,
    type PDFImage,
    type PDFObject
} from '@cantoo/pdf-lib';

import { imagePageSize, rotateBy, type PlanPage } from './model';

/**
 * L'assemblage du document : les pages du plan copiées depuis leurs fichiers
 * dans un PDF neuf, par pdf-lib. Tourne dans un worker, sans rien du DOM ; se
 * teste sous Node.
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

export interface BuildInput {
    sources: readonly BuildSource[];
    images: readonly BuildImage[];
    pages: readonly PlanPage[];
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

    const embedded = new Map<string, PDFImage>();
    const total = input.pages.length;
    for (const [i, page] of input.pages.entries()) {
        switch (page.kind) {
            case 'source': {
                const l = loaded.get(page.sourceId);
                if (!l || page.index >= l.doc.getPageCount()) {
                    throw new BuildFailure('corrupt', 'Une page du plan ne se trouve plus dans son fichier.');
                }
                const copied = l.copier.copy(l.doc.getPage(page.index).node);
                const added = dst.addPage(PDFPage.of(copied, dst.context.register(copied), dst));
                added.setRotation(degrees(rotateBy(added.getRotation().angle, page.rotation)));
                break;
            }
            case 'blank': {
                dst.addPage([page.width, page.height]).setRotation(degrees(page.rotation));
                break;
            }
            case 'image': {
                const image = input.images.find((img) => img.id === page.imageId);
                if (!image) throw new BuildFailure('image', 'Une image du document manque.');
                let embed = embedded.get(image.id);
                if (!embed) {
                    try {
                        embed =
                            image.mime === 'image/png'
                                ? await dst.embedPng(image.bytes)
                                : await dst.embedJpg(image.bytes);
                    } catch {
                        throw new BuildFailure('image', 'Une image du document ne se lit pas.');
                    }
                    embedded.set(image.id, embed);
                }
                const size = imagePageSize(image);
                const added = dst.addPage([size.width, size.height]);
                added.drawImage(embed, { x: 0, y: 0, width: size.width, height: size.height });
                added.setRotation(degrees(page.rotation));
                break;
            }
        }
        onProgress(i + 1, total);
    }

    const owner = formOwner === null ? undefined : loaded.get(formOwner);
    if (owner) copyAcroForm(dst, owner);
    return dst.save();
}
