import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { importManifest, readFeatureConfig, resolveModuleDir, tablePrefix } from './features-config';

/**
 * La lecture des configs de modules et la résolution d'un module, sur une
 * racine factice : un module privé par chemin, un paquet dans node_modules.
 */
describe('features-config', () => {
    let root: string;
    const privateEntry = { package: 'deveye-feature-tally', path: 'mod' };

    before(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'deveye-features-config-'));
        fs.mkdirSync(path.join(root, 'mod', 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'mod', 'src', 'index.ts'),
            "export const manifest = { id: 'x-tally', label: 'Tally' };\n"
        );
        fs.mkdirSync(path.join(root, 'node_modules', 'deveye-feature-pkg'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'node_modules', 'deveye-feature-pkg', 'package.json'),
            '{ "name": "deveye-feature-pkg" }\n'
        );
        fs.writeFileSync(path.join(root, 'features.local.json'), JSON.stringify({ features: [privateEntry] }));
    });
    after(() => fs.rmSync(root, { recursive: true, force: true }));

    it('lit les entrées d’une config, et aucune sans le fichier', () => {
        assert.deepEqual(readFeatureConfig(root, 'features.local.json'), [privateEntry]);
        assert.deepEqual(readFeatureConfig(root, 'features.config.json'), []);
    });

    it('résout un module privé par son chemin, un paquet dans node_modules, sinon rien', () => {
        assert.equal(resolveModuleDir(root, privateEntry), path.join(root, 'mod'));
        assert.equal(
            resolveModuleDir(root, { package: 'deveye-feature-pkg' }),
            path.join(root, 'node_modules', 'deveye-feature-pkg')
        );
        assert.equal(resolveModuleDir(root, { package: 'deveye-feature-absent' }), null);
    });

    it('importe le manifest d’un module privé par son src/index.ts', async () => {
        const manifest = await importManifest(root, privateEntry);
        assert.equal(manifest?.id, 'x-tally');
    });
});

describe('tablePrefix', () => {
    it('ôte le « x- » d’un id externe, garde tel quel un id natif', () => {
        assert.equal(tablePrefix('x-countdown'), 'ft_countdown_');
        assert.equal(tablePrefix('weather'), 'ft_weather_');
    });
});
