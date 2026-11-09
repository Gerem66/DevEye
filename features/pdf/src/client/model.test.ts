import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    addImage,
    addSource,
    displayedSize,
    duplicatePages,
    EMPTY_PLAN,
    imagePageSize,
    insertBlank,
    moveTogether,
    downloadName,
    outputName,
    pagesBetween,
    pagesByParity,
    removePages,
    reorderPages,
    rotateBy,
    rotatePages,
    routesToWorkshop,
    summarize,
    totalRotation,
    type Plan,
    type SourceInfo
} from './model';

const source = (id: string, pages: number, rotate: 0 | 90 = 0): SourceInfo => ({
    id,
    name: `${id}.pdf`,
    bytes: 1000,
    pages: Array.from({ length: pages }, () => ({ view: [0, 0, 400, 600] as const, rotate })),
    protectedByPassword: false,
    hasForm: false,
    pureXfa: false,
    color: 0,
    meta: { title: '', author: '', subject: '' }
});

const ids = (plan: Plan) => plan.pages.map((p) => p.id);
const origins = (plan: Plan) => plan.pages.map((p) => (p.kind === 'source' ? `${p.sourceId}:${p.index}` : p.kind));

describe('plan des pages', () => {
    it('ajoute les pages d’un fichier, à la fin ou à un rang', () => {
        let plan = addSource(EMPTY_PLAN, source('a', 2));
        plan = addSource(plan, source('b', 1), 1);
        assert.deepEqual(origins(plan), ['a:0', 'b:0', 'a:1']);
        assert.equal(summarize(plan), '2 fichiers · 3 pages');
    });

    it('réordonne les pages, et refuse un ordre incomplet', () => {
        const plan = addSource(EMPTY_PLAN, source('a', 3));
        const [p0, p1, p2] = ids(plan);
        assert.deepEqual(origins(reorderPages(plan, [p2, p0, p1])), ['a:2', 'a:0', 'a:1']);
        assert.equal(reorderPages(plan, [p2, p0]), plan);
    });

    it('déplace toute la sélection avec la page glissée', () => {
        const before = ['a', 'b', 'c', 'd'];
        // Sélection a et c ; c glisse en tête : a la suit, et passe devant comme avant.
        assert.deepEqual(moveTogether(before, ['c', 'a', 'b', 'd'], 'c', ['a', 'c']), ['a', 'c', 'b', 'd']);
        // Page glissée hors sélection : l'ordre reçu vaut tel quel.
        assert.deepEqual(moveTogether(before, ['b', 'a', 'c', 'd'], 'b', ['a', 'c']), ['b', 'a', 'c', 'd']);
        // d glisse avant c avec b : le bloc b, d se pose là.
        assert.deepEqual(moveTogether(before, ['a', 'b', 'd', 'c'], 'd', ['b', 'd']), ['a', 'b', 'd', 'c']);
    });

    it('retire, pivote et duplique', () => {
        let plan = addSource(EMPTY_PLAN, source('a', 3));
        const [p0, p1, p2] = ids(plan);
        assert.deepEqual(origins(removePages(plan, [p1])), ['a:0', 'a:2']);
        plan = rotatePages(plan, [p0], 90);
        assert.equal(plan.pages[0].rotation, 90);
        assert.equal(rotatePages(plan, [p0], -90).pages[0].rotation, 0);
        assert.equal(rotatePages(plan, [p0], 180).pages[0].rotation, 270);
        const { plan: dup, created } = duplicatePages(plan, [p0, p2]);
        assert.deepEqual(origins(dup), ['a:0', 'a:0', 'a:1', 'a:2', 'a:2']);
        assert.deepEqual(created, [dup.pages[1].id, dup.pages[4].id]);
        assert.equal(dup.pages[1].rotation, 90);
    });

    it('oublie une image dont la dernière page part', () => {
        let plan = addImage(EMPTY_PLAN, { id: 'i', name: 'photo.jpg', width: 3000, height: 2000, mime: 'image/jpeg' });
        assert.equal(plan.images.length, 1);
        plan = removePages(plan, [plan.pages[0].id]);
        assert.equal(plan.images.length, 0);
    });

    it('insère une page blanche à la taille affichée de sa voisine', () => {
        let plan = addSource(EMPTY_PLAN, source('a', 1, 90));
        const { plan: next, id } = insertBlank(plan, plan.pages[0].id);
        const blank = next.pages[1];
        assert.equal(blank.id, id);
        assert.ok(blank.kind === 'blank');
        // Une page 400 × 600 tournée d'un quart : la blanche fait 600 × 400.
        assert.deepEqual({ width: blank.width, height: blank.height }, { width: 600, height: 400 });
        plan = insertBlank(EMPTY_PLAN, null).plan;
        assert.equal(plan.pages.length, 1);
    });

    it('compose la rotation du fichier et celle de l’atelier', () => {
        const plan = rotatePages(addSource(EMPTY_PLAN, source('a', 1, 90)), [], 90);
        const page = plan.pages[0];
        assert.equal(totalRotation(page, plan), 90);
        assert.deepEqual(displayedSize(page, plan), { width: 600, height: 400 });
        const turned = rotatePages(plan, [page.id], 90);
        assert.equal(totalRotation(turned.pages[0], turned), 180);
        assert.deepEqual(displayedSize(turned.pages[0], turned), { width: 400, height: 600 });
        assert.equal(rotateBy(-90, 0), 270);
        assert.equal(rotateBy(450, 90), 180);
    });

    it('donne à une image le côté long d’un A4', () => {
        const size = imagePageSize({ width: 4000, height: 3000 });
        assert.ok(Math.abs(size.width - 841.89) < 0.01);
        assert.ok(Math.abs(size.height - 631.42) < 0.01);
    });

    it('sélectionne par parité et par plage', () => {
        const plan = addSource(EMPTY_PLAN, source('a', 5));
        const [p0, p1, p2, p3, p4] = ids(plan);
        assert.deepEqual(pagesByParity(plan, 'odd'), [p0, p2, p4]);
        assert.deepEqual(pagesByParity(plan, 'even'), [p1, p3]);
        assert.deepEqual(pagesBetween(plan, p3, p1), [p1, p2, p3]);
        assert.deepEqual(pagesBetween(plan, 'absent', p1), [p1]);
    });

    it('nomme le fichier produit', () => {
        assert.equal(outputName(EMPTY_PLAN), 'document.pdf');
        assert.equal(outputName(addSource(EMPTY_PLAN, { ...source('a', 1), name: 'Contrat.PDF' })), 'Contrat.pdf');
        const two = addSource(addSource(EMPTY_PLAN, { ...source('a', 1), name: 'Devis.pdf' }), source('b', 1));
        assert.equal(outputName(two), 'Devis et 1 autre.pdf');
        assert.equal(outputName(addSource(two, source('c', 1))), 'Devis et 2 autres.pdf');
    });

    it('le nom tapé prend le pas et finit toujours en .pdf', () => {
        assert.equal(downloadName(null, EMPTY_PLAN), 'document.pdf');
        assert.equal(downloadName('  ', EMPTY_PLAN), 'document.pdf');
        assert.equal(downloadName('devis signé', EMPTY_PLAN), 'devis signé.pdf');
        assert.equal(downloadName('devis.PDF', EMPTY_PLAN), 'devis.PDF');
    });

    it('aiguille vers l’atelier un PDF, ou plusieurs images, jamais une vidéo', () => {
        const pdf = { name: 'a.pdf', type: 'application/pdf' };
        const png = { name: 'a.png', type: 'image/png' };
        assert.equal(routesToWorkshop([pdf]), true);
        assert.equal(routesToWorkshop([png]), false);
        assert.equal(routesToWorkshop([png, png]), true);
        assert.equal(routesToWorkshop([pdf, { name: 'v.mp4', type: 'video/mp4' }]), false);
        assert.equal(routesToWorkshop([{ name: 'x.PDF', type: '' }]), true);
        assert.equal(routesToWorkshop([]), false);
    });
});
