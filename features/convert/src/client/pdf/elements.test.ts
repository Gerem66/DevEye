import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    centredBox,
    clampToPage,
    inkPath,
    rectBetween,
    replicate,
    rotateRect,
    strokesPath,
    textHeight,
    todayLabel
} from './elements';

describe('éléments posés sur une page', () => {
    const a4 = { width: 595, height: 842 };

    it('ramène une boîte dans la page', () => {
        assert.deepEqual(clampToPage({ x: -10, y: 900, width: 100, height: 50 }, a4), {
            x: 0,
            y: 792,
            width: 100,
            height: 50
        });
        assert.deepEqual(centredBox({ x: 0, y: 0 }, { width: 40, height: 20 }, a4), {
            x: 0,
            y: 0,
            width: 40,
            height: 20
        });
        assert.deepEqual(rectBetween({ x: 10, y: 30 }, { x: 5, y: 10 }), { x: 5, y: 10, width: 5, height: 20 });
    });

    it('reproduit un paraphe à la même distance des bords les plus proches', () => {
        // En bas à droite d'un A4 : à 20 pt du bord droit et 30 pt du bas.
        const initials = { x: 595 - 60 - 20, y: 842 - 30 - 30, width: 60, height: 30 };
        const landscape = { width: 842, height: 595 };
        assert.deepEqual(replicate(initials, a4, landscape), {
            x: 842 - 60 - 20,
            y: 595 - 30 - 30,
            width: 60,
            height: 30
        });
        // En haut à gauche : il y reste.
        assert.deepEqual(replicate({ x: 20, y: 20, width: 60, height: 30 }, a4, landscape), {
            x: 20,
            y: 20,
            width: 60,
            height: 30
        });
    });

    it('suit la page qui tourne, sans changer de dimensions', () => {
        const rect = { x: 0, y: 0, width: 100, height: 50 };
        // Un quart à droite : le centre va contre le bord droit, la boîte rentre dans la page.
        const turned = rotateRect(rect, a4, 90);
        assert.deepEqual(turned, { x: 842 - 100, y: 25, width: 100, height: 50 });
        const back = rotateRect(turned, { width: 842, height: 595 }, -90);
        assert.deepEqual(back, { x: 0, y: 25, width: 100, height: 50 });
        assert.deepEqual(rotateRect(rect, a4, 180), { x: 595 - 100, y: 842 - 50, width: 100, height: 50 });
    });

    it('normalise un trait dans sa boîte', () => {
        const ink = inkPath(
            [
                { x: 10, y: 10 },
                { x: 20, y: 30 }
            ],
            2
        );
        assert.ok(ink);
        assert.deepEqual(ink.box, { x: 9, y: 9, width: 12, height: 22 });
        assert.equal(ink.path, 'M 1 1 L 11 21');
        assert.equal(inkPath([], 2), null);
        const strokes = strokesPath(
            [
                [
                    { x: 0, y: 0 },
                    { x: 4, y: 0 }
                ],
                [{ x: 0, y: 4 }]
            ],
            0
        );
        assert.equal(strokes?.path, 'M 0 0 L 4 0 M 0 4');
    });

    it('mesure un texte et date le jour', () => {
        assert.equal(textHeight('a\nb', 10), 24);
        assert.equal(todayLabel(new Date(2026, 10, 9)), '09/11/2026');
    });
});
