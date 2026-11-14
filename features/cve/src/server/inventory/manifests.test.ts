import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { goDirect, parseManifest } from './manifests';
import { inventoryOfFiles } from './repoFiles';

describe('les dépendances directes', () => {
    it('se lisent dans chaque manifeste', () => {
        assert.deepEqual(
            parseManifest('package.json', '{"dependencies":{"react":"^19"},"devDependencies":{"vite":"6"}}')?.names,
            ['react', 'vite']
        );
        assert.deepEqual(
            parseManifest(
                'agent/Cargo.toml',
                '[package]\nname = "a"\n[dependencies]\ntokio = "1"\nserde = { version = "1" }\n'
            )?.names,
            ['tokio', 'serde']
        );
        assert.deepEqual(
            parseManifest('pyproject.toml', '[project]\ndependencies = ["Requests>=2", "flask_cors"]\n')?.names,
            ['requests', 'flask-cors']
        );
        assert.deepEqual(goDirect('require (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/c/d v2.0.0 // indirect\n)\n'), [
            'github.com/a/b'
        ]);
    });

    it('marquent les paquets du verrou voisin que le projet déclare', () => {
        const lock = JSON.stringify({
            lockfileVersion: 3,
            packages: {
                '': {},
                'node_modules/react': { version: '18.2.0' },
                'node_modules/scheduler': { version: '0.23.0' }
            }
        });
        const inventory = inventoryOfFiles([
            { path: 'client/package-lock.json', text: lock },
            { path: 'client/package.json', text: '{"dependencies":{"react":"^18"}}' }
        ]);
        assert.deepEqual(
            inventory.components.map((c) => `${c.name}:${c.direct === true}`),
            ['react:true', 'scheduler:false']
        );
    });
});
