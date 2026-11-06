import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseExcalidraw } from './importFile';

describe('parseExcalidraw', () => {
    it('complète un ancien fichier et ne garde que les images montrées', () => {
        const board = parseExcalidraw(
            'Archi.excalidraw',
            JSON.stringify({
                type: 'excalidraw',
                version: 2,
                appState: { viewBackgroundColor: '#fffce8', theme: 'sombre' },
                elements: [
                    { id: 'a', type: 'rectangle', version: 3, versionNonce: 7 },
                    { id: 'b', type: 'image', fileId: 'f1' },
                    { id: 'c', type: 'rectangle', isDeleted: true }
                ],
                files: {
                    f1: { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' },
                    f2: { id: 'f2', mimeType: 'image/png', dataURL: 'data:image/png;base64,BBBB' }
                }
            })
        );
        assert.equal(board.title, 'Archi');
        assert.deepEqual(
            board.elements.map((e) => [e.id, e.version, typeof e.updated]),
            [
                ['a', 3, 'number'],
                ['b', 1, 'number']
            ]
        );
        assert.deepEqual(
            board.files.map((f) => f.id),
            ['f1']
        );
        assert.deepEqual(board.appearance, { background: '#fffce8', theme: null });
    });

    it('refuse ce qui n’est pas un dessin', () => {
        assert.throws(() => parseExcalidraw('x.json', '{"type":"autre"}'), /pas un dessin/);
        assert.throws(() => parseExcalidraw('x.json', 'pas du json'), /pas un dessin/);
    });
});
