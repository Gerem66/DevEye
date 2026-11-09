import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { anchor, frameSize, toUser, toView, userRect, type Frame } from './geometry';

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9, `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
};

describe('repères du fichier et du cadre', () => {
    const page: Frame = { view: [0, 0, 400, 600], rotation: 0 };

    it('sans rotation, renverse l’axe vertical', () => {
        assert.deepEqual(frameSize(page), { width: 400, height: 600 });
        close(toView(page, { x: 0, y: 600 }), { x: 0, y: 0 });
        close(toView(page, { x: 400, y: 0 }), { x: 400, y: 600 });
        close(toUser(page, { x: 10, y: 20 }), { x: 10, y: 580 });
    });

    it('à 90°, le haut du fichier vient à droite', () => {
        const frame: Frame = { ...page, rotation: 90 };
        assert.deepEqual(frameSize(frame), { width: 600, height: 400 });
        // Le coin bas-gauche du fichier s'affiche en haut à gauche.
        close(toView(frame, { x: 0, y: 0 }), { x: 0, y: 0 });
        // Le coin haut-gauche du fichier s'affiche en haut à droite.
        close(toView(frame, { x: 0, y: 600 }), { x: 600, y: 0 });
        close(toUser(frame, toView(frame, { x: 123, y: 45 })), { x: 123, y: 45 });
    });

    it('à 180° et 270°, aller et retour se répondent', () => {
        for (const rotation of [180, 270] as const) {
            const frame: Frame = { ...page, rotation };
            close(toUser(frame, toView(frame, { x: 37, y: 512 })), { x: 37, y: 512 });
        }
        const upside: Frame = { ...page, rotation: 180 };
        close(toView(upside, { x: 0, y: 0 }), { x: 400, y: 0 });
    });

    it('tient compte d’une boîte qui ne part pas de l’origine', () => {
        const frame: Frame = { view: [50, 60, 350, 460], rotation: 0 };
        assert.deepEqual(frameSize(frame), { width: 300, height: 400 });
        close(toView(frame, { x: 50, y: 460 }), { x: 0, y: 0 });
        close(toUser(frame, { x: 0, y: 400 }), { x: 50, y: 60 });
    });

    it('ramène un rectangle affiché dans le fichier, axes alignés', () => {
        const rect = { x: 10, y: 20, width: 100, height: 50 };
        assert.deepEqual(userRect(page, rect), { x: 10, y: 530, width: 100, height: 50 });
        const turned = userRect({ ...page, rotation: 90 }, rect);
        // Tourné d'un quart : largeur et hauteur s'échangent.
        assert.deepEqual(turned, { x: 20, y: 10, width: 50, height: 100 });
    });

    it('donne à pdf-lib le coin bas-gauche affiché et la rotation de la page', () => {
        const rect = { x: 10, y: 20, width: 100, height: 50 };
        assert.deepEqual(anchor(page, rect), { x: 10, y: 530, rotate: 0 });
        const turned = anchor({ ...page, rotation: 90 }, rect);
        assert.deepEqual(turned, { x: 70, y: 10, rotate: 90 });
    });
});
