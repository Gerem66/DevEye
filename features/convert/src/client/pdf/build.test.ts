import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { degrees, PDFDocument, PDFName } from '@cantoo/pdf-lib';

import { BuildFailure, buildPdf, type BuildInput, type BuildSource } from './build';
import type { PlanPage } from './model';

interface Spec {
    size?: [number, number];
    rotate?: number;
    field?: string;
}

async function makePdf(pages: Spec[], password?: string): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    for (const spec of pages) {
        const page = doc.addPage(spec.size ?? [400, 600]);
        if (spec.rotate) page.setRotation(degrees(spec.rotate));
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
});
