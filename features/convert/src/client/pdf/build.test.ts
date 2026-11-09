import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { degrees, PDFDocument, PDFName } from '@cantoo/pdf-lib';

import { readFileSync } from 'node:fs';

import { BuildFailure, buildPdf, type BuildInput, type BuildSource } from './build';
import type { PdfElement } from './elements';
import type { PlanPage } from './model';

interface Spec {
    size?: [number, number];
    rotate?: number;
    field?: string;
    text?: string;
}

async function makePdf(pages: Spec[], password?: string): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    for (const spec of pages) {
        const page = doc.addPage(spec.size ?? [400, 600]);
        if (spec.rotate) page.setRotation(degrees(spec.rotate));
        if (spec.text) page.drawText(spec.text, { x: 20, y: 500, size: 14 });
        if (spec.field) {
            doc.getForm().createTextField(spec.field).addToPage(page, { x: 20, y: 20, width: 200, height: 30 });
        }
    }
    if (password !== undefined) doc.encrypt({ userPassword: password });
    return doc.save();
}

const src = (id: string, bytes: Uint8Array, password: string | null = null): BuildSource => ({ id, bytes, password });
const page = (sourceId: string, index: number, rotation: PlanPage['rotation'] = 0): PlanPage => ({
    id: `${sourceId}-${index}-${rotation}`,
    kind: 'source',
    sourceId,
    index,
    rotation
});

const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
);

const fieldNames = (doc: PDFDocument): string[] =>
    doc
        .getForm()
        .getFields()
        .map((f) => f.getName());

describe('assemblage du PDF', () => {
    it('copie les pages dans l’ordre du plan, avec les blanches et les images', async () => {
        const a = await makePdf([{}, { size: [300, 300] }]);
        const b = await makePdf([{ size: [500, 200] }]);
        const steps: number[] = [];
        const bytes = await buildPdf(
            {
                sources: [src('a', a), src('b', b)],
                images: [{ id: 'i', bytes: PNG_1X1, mime: 'image/png', width: 1, height: 1 }],
                pages: [
                    page('b', 0),
                    page('a', 1),
                    { id: 'blank', kind: 'blank', width: 100, height: 50, rotation: 0 },
                    { id: 'img', kind: 'image', imageId: 'i', rotation: 0 },
                    page('a', 0)
                ]
            },
            (done) => steps.push(done)
        );
        const out = await PDFDocument.load(bytes);
        assert.equal(out.getPageCount(), 5);
        const sizes = out.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
        assert.deepEqual(sizes, [
            [500, 200],
            [300, 300],
            [100, 50],
            [842, 842],
            [400, 600]
        ]);
        assert.deepEqual(steps, [1, 2, 3, 4, 5]);
    });

    it('ajoute la rotation de l’atelier à celle que la page avait', async () => {
        const a = await makePdf([{ rotate: 90 }, {}]);
        const bytes = await buildPdf({
            sources: [src('a', a)],
            images: [],
            pages: [
                page('a', 0, 90),
                page('a', 1, 270),
                { id: 'b', kind: 'blank', width: 10, height: 10, rotation: 180 }
            ]
        });
        const out = await PDFDocument.load(bytes);
        assert.deepEqual(
            out.getPages().map((p) => p.getRotation().angle),
            [180, 270, 180]
        );
    });

    it('garde remplissables les champs d’un seul fichier, et seulement ceux des pages gardées', async () => {
        const a = await makePdf([{ field: 'ville' }, { field: 'nom' }, {}]);
        const bytes = await buildPdf({ sources: [src('a', a)], images: [], pages: [page('a', 2), page('a', 1)] });
        const out = await PDFDocument.load(bytes);
        assert.deepEqual(fieldNames(out), ['nom']);
        assert.equal(out.getPageCount(), 2);
        assert.equal(out.getPage(1).node.Annots()?.size(), 1);
        // La page écartée n'a pas suivi le champ qu'elle portait.
        const plain = await buildPdf({
            sources: [src('a', await makePdf([{}, {}, {}]))],
            images: [],
            pages: [page('a', 2), page('a', 1)]
        });
        assert.ok(bytes.length < plain.length + 1500, `${bytes.length} octets contre ${plain.length} sans formulaire`);
    });

    it('fige les champs quand ils viennent de plusieurs fichiers', async () => {
        const a = await makePdf([{ field: 'nom' }]);
        const b = await makePdf([{ field: 'nom' }]);
        const bytes = await buildPdf({
            sources: [src('a', a), src('b', b)],
            images: [],
            pages: [page('a', 0), page('b', 0)]
        });
        const out = await PDFDocument.load(bytes);
        assert.equal(out.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFName) ?? undefined, undefined);
        assert.equal(out.catalog.get(PDFName.of('AcroForm')), undefined);
    });

    it('ouvre un fichier protégé avec son mot de passe, et le rend libre', async () => {
        const a = await makePdf([{}], 'abc');
        const bytes = await buildPdf({ sources: [src('a', a, 'abc')], images: [], pages: [page('a', 0)] });
        const out = await PDFDocument.load(bytes);
        assert.equal(out.getPageCount(), 1);
        await assert.rejects(
            buildPdf({ sources: [src('a', a, 'wrong')], images: [], pages: [page('a', 0)] }),
            (e: unknown) => e instanceof BuildFailure && e.code === 'password'
        );
        await assert.rejects(
            buildPdf({ sources: [src('a', a)], images: [], pages: [page('a', 0)] }),
            (e: unknown) => e instanceof BuildFailure && e.code === 'password'
        );
    });

    it('refuse un plan vide, une page absente du fichier, une image qui manque', async () => {
        const a = await makePdf([{}]);
        const empty: BuildInput = { sources: [src('a', a)], images: [], pages: [] };
        await assert.rejects(buildPdf(empty), (e: unknown) => e instanceof BuildFailure && e.code === 'empty');
        await assert.rejects(
            buildPdf({ sources: [src('a', a)], images: [], pages: [page('a', 4)] }),
            (e: unknown) => e instanceof BuildFailure && e.code === 'corrupt'
        );
        await assert.rejects(
            buildPdf({ sources: [], images: [], pages: [{ id: 'x', kind: 'image', imageId: 'nope', rotation: 0 }] }),
            (e: unknown) => e instanceof BuildFailure && e.code === 'image'
        );
    });

    it('dessine ce qui est posé : texte accentué, signature, coche sur chaque page, surlignage', async () => {
        const a = await makePdf([{ text: 'un' }, { text: 'deux', rotate: 90 }]);
        const fonts = {
            sans: new Uint8Array(readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')),
            hand: new Uint8Array(readFileSync('node_modules/@fontsource/caveat/files/caveat-latin-400-normal.woff'))
        };
        const p1 = page('a', 0);
        const p2 = page('a', 1);
        const base = { everyPage: false, x: 40, y: 40, width: 200, height: 20 };
        const elements: PdfElement[] = [
            {
                ...base,
                id: 'e1',
                pageId: p1.id,
                kind: 'text',
                text: 'Bon pour accord, Gérémy',
                size: 12,
                color: 'blue',
                hand: false
            },
            {
                ...base,
                id: 'e2',
                pageId: p1.id,
                kind: 'signature',
                color: 'black',
                y: 80,
                height: 60,
                signature: { kind: 'path', path: 'M 0 10 L 50 0 L 100 20', width: 100, height: 20, stroke: 2 }
            },
            {
                ...base,
                id: 'e3',
                pageId: p1.id,
                kind: 'signature',
                color: 'black',
                y: 160,
                height: 40,
                signature: { kind: 'text', text: 'Gérémy' }
            },
            {
                ...base,
                id: 'e4',
                pageId: p1.id,
                kind: 'mark',
                mark: 'check',
                color: 'green',
                everyPage: true,
                x: 360,
                y: 560,
                width: 16,
                height: 16
            },
            {
                ...base,
                id: 'e5',
                pageId: p2.id,
                kind: 'highlight',
                color: 'yellow',
                x: 10,
                y: 10,
                width: 100,
                height: 30
            },
            { ...base, id: 'e6', pageId: p2.id, kind: 'box', fill: 'white', border: 'red' },
            {
                ...base,
                id: 'e7',
                pageId: p2.id,
                kind: 'ink',
                path: 'M 0 0 L 10 10',
                pathWidth: 10,
                pathHeight: 10,
                color: 'red',
                stroke: 2
            }
        ];
        const bytes = await buildPdf({ sources: [src('a', a)], images: [], pages: [p1, p2], elements, fonts });
        const out = await PDFDocument.load(bytes);
        assert.equal(out.getPageCount(), 2);
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const task = pdfjs.getDocument({
            data: bytes.slice(),
            useWorkerFetch: false,
            standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/'
        });
        const doc = await task.promise;
        const text = async (n: number) =>
            (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
        assert.match(await text(1), /Bon pour accord, Gérémy/);
        assert.match(await text(1), /un/);
        assert.match(await text(2), /deux/);
        await task.destroy();
        // Sans police embarquée, Helvetica écrit ce qu'elle peut, sans lever d'erreur.
        const plain = await buildPdf({
            sources: [src('a', a)],
            images: [],
            pages: [p1],
            elements: [
                {
                    ...base,
                    id: 'e8',
                    pageId: p1.id,
                    kind: 'text',
                    text: 'Œuvre à 10 €',
                    size: 12,
                    color: 'black',
                    hand: false
                }
            ]
        });
        assert.ok(plain.length > 0);
    });

    it('remplace une page caviardée par son image : le texte dessous n’existe plus', async () => {
        const a = await makePdf([{ text: 'visible' }, { text: 'secret' }]);
        const p1 = page('a', 0);
        const p2 = page('a', 1);
        const bytes = await buildPdf({
            sources: [src('a', a)],
            images: [],
            pages: [p1, p2],
            elements: [
                { id: 'r', pageId: p2.id, kind: 'redact', everyPage: false, x: 10, y: 10, width: 50, height: 20 }
            ],
            redactions: [{ pageId: p2.id, bytes: PNG_1X1, mime: 'image/png', width: 400, height: 600 }]
        });
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const task = pdfjs.getDocument({
            data: bytes.slice(),
            useWorkerFetch: false,
            standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/'
        });
        const doc = await task.promise;
        const text = async (n: number) =>
            (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
        assert.match(await text(1), /visible/);
        assert.doesNotMatch(await text(2), /secret/);
        const second = await doc.getPage(2);
        assert.deepEqual([second.view[2], second.view[3]], [400, 600]);
        await task.destroy();
        // Sans image de la page, le rectangle noir est dessiné tel quel.
        const covered = await buildPdf({
            sources: [src('a', a)],
            images: [],
            pages: [p2],
            elements: [
                { id: 'r', pageId: p2.id, kind: 'redact', everyPage: false, x: 10, y: 10, width: 50, height: 20 }
            ]
        });
        assert.ok(covered.length > 0);
    });

    it('remplit les champs, les laisse remplissables ou les fige', async () => {
        const a = await makePdf([{ field: 'nom' }, { field: 'ville' }]);
        const fonts = {
            sans: new Uint8Array(readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')),
            hand: null
        };
        const p1 = page('a', 0);
        const p2 = page('a', 1);
        const fields = { a: { nom: 'Gérémy Pérez', ville: 'Lyon' } };
        const live = await buildPdf({ sources: [src('a', a)], images: [], pages: [p1, p2], fields, fonts });
        const out = await PDFDocument.load(live);
        assert.equal(out.getForm().getTextField('nom').getText(), 'Gérémy Pérez');
        assert.equal(out.getForm().getTextField('ville').getText(), 'Lyon');

        const flat = await buildPdf({
            sources: [src('a', a)],
            images: [],
            pages: [p1, p2],
            fields,
            fonts,
            flatten: true
        });
        assert.equal((await PDFDocument.load(flat)).catalog.get(PDFName.of('AcroForm')), undefined);
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const task = pdfjs.getDocument({
            data: flat.slice(),
            useWorkerFetch: false,
            standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/'
        });
        const doc = await task.promise;
        const text = (await (await doc.getPage(1)).getTextContent()).items
            .map((i) => ('str' in i ? i.str : ''))
            .join(' ');
        assert.match(text, /Gérémy Pérez/);
        await task.destroy();
    });
});
