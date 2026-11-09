import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boundedScale, imageFileName, pixelSize, selectionForExport } from './imageExport';

describe('boundedScale', () => {
    it('garde l’agrandissement demandé tant que le navigateur sait dessiner l’image', () => {
        assert.equal(boundedScale(1200, 800, 3), 3);
        assert.deepEqual(pixelSize(1200, 800, 2), { width: 2400, height: 1600 });
    });

    it('réduit une scène très large sous le plafond d’un côté', () => {
        const { width } = pixelSize(10_000, 500, 3);
        assert.equal(width, 16_384);
    });

    it('réduit une grande scène sous le plafond de pixels', () => {
        const { width, height } = pixelSize(8000, 8000, 3);
        assert.ok(width * height <= 100_000_000);
        assert.ok(width * height > 99_000_000);
    });
});

describe('imageFileName', () => {
    it('reprend le titre avec l’extension du format', () => {
        assert.equal(imageFileName('Schéma réseau', 'png'), 'Schéma réseau.png');
        assert.equal(imageFileName('Schéma réseau', 'jpeg'), 'Schéma réseau.jpg');
    });

    it('écarte ce qu’un système de fichiers refuse', () => {
        assert.equal(imageFileName('  a/b: c?\n', 'svg'), 'a b c.svg');
        assert.equal(imageFileName('..', 'webp'), 'Tableau blanc.webp');
        assert.equal(imageFileName('', 'png'), 'Tableau blanc.png');
    });
});

describe('selectionForExport', () => {
    it('emporte le texte d’une forme choisie et le contenu d’un cadre choisi', () => {
        const elements = [
            { id: 'box', frameId: null },
            { id: 'label', frameId: null, containerId: 'box' },
            { id: 'frame', frameId: null },
            { id: 'inside', frameId: 'frame' },
            { id: 'other', frameId: null }
        ];
        const picked = selectionForExport(elements, { box: true, frame: true, other: false });
        assert.deepEqual(
            picked.map((element) => element.id),
            ['box', 'label', 'frame', 'inside']
        );
    });
});
