import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inventoryOfFiles, wantsRepoFile } from './repoFiles';
import { exactVersion, findTools } from './tools';

/** Les outils d'un dépôt : ce qui se repère, et ce qui ne se compare pas. */

const tools = (path: string, text: string) =>
    findTools(path, text)
        .filter((t) => t.exact)
        .map((t) => `${t.tool}@${t.version}:${t.line}`);

describe('le repérage des outils', () => {
    it('lit les images d’un Dockerfile et d’un compose, à leur version exacte', () => {
        const docker = [
            'FROM node:20.11.1-alpine AS build',
            'RUN npm ci',
            'FROM --platform=linux/amd64 nginx:1.25.3'
        ].join('\n');
        assert.deepEqual(tools('Dockerfile', docker), ['node@20.11.1:1', 'nginx@1.25.3:3']);
        const compose = ['services:', '  db:', '    image: postgres:16.1', '  cache:', '    image: "redis:7.2"'].join(
            '\n'
        );
        assert.deepEqual(tools('docker-compose.yml', compose), ['postgres@16.1:3']);
    });

    it('garde une étiquette flottante pour sa branche seulement, et écarte une image inconnue', () => {
        assert.deepEqual(tools('Dockerfile', 'FROM node:20\nFROM nginx:latest\nFROM acme/app:1.2.3'), []);
        assert.deepEqual(
            findTools('Dockerfile', 'FROM node:20-alpine').map((t) => `${t.tool}@${t.version}:${t.exact}`),
            ['node@20:false']
        );
        assert.equal(exactVersion('redis', '7.2'), null);
        assert.equal(exactVersion('postgres', '16.1-bookworm'), '16.1');
    });

    it('lit les fichiers de version des outils', () => {
        assert.deepEqual(tools('.nvmrc', 'v20.11.1\n'), ['node@20.11.1:1']);
        assert.deepEqual(tools('.tool-versions', 'nodejs 20.11.1\npython 3.12.1\nterraform 1.6.0\n'), [
            'node@20.11.1:1',
            'python@3.12.1:2'
        ]);
        assert.deepEqual(tools('rust-toolchain.toml', '[toolchain]\nchannel = "1.76.0"\n'), ['rust@1.76.0:2']);
        assert.deepEqual(tools('package.json', '{ "engines": { "node": "20.11.1" } }'), ['node@20.11.1:1']);
        assert.deepEqual(tools('package.json', '{ "engines": { "node": ">=20" } }'), []);
    });
});

describe('l’inventaire d’un dépôt', () => {
    it('ne demande ni les dépendances recopiées ni les fichiers sans rapport', () => {
        assert.equal(wantsRepoFile('package-lock.json'), true);
        assert.equal(wantsRepoFile('client/Dockerfile'), true);
        assert.equal(wantsRepoFile('node_modules/foo/package-lock.json'), false);
        assert.equal(wantsRepoFile('vendor/bar/composer.lock'), false);
        assert.equal(wantsRepoFile('README.md'), false);
    });

    it('rend chaque composant une fois, et chaque fichier lu avec ce qu’il a donné', () => {
        const lock = JSON.stringify({
            lockfileVersion: 3,
            packages: { '': {}, 'node_modules/lodash': { version: '4.17.20' } }
        });
        const inventory = inventoryOfFiles([
            { path: 'package-lock.json', text: lock },
            { path: 'client/package-lock.json', text: lock },
            { path: 'Dockerfile', text: 'FROM node:20' },
            { path: 'package.json', text: '{}' },
            { path: '.nvmrc', text: '20.11.1' }
        ]);
        assert.deepEqual(
            inventory.components.map((c) => `${c.kind}:${c.ecosystem}:${c.name}@${c.version}:${c.path}`),
            [
                'package:npm:lodash@4.17.20:package-lock.json',
                'product:node:Node.js@20:Dockerfile',
                'product:node:Node.js@20.11.1:.nvmrc'
            ]
        );
        assert.deepEqual(
            inventory.formats.map((f) => `${f.format}:${f.path}:${f.count}`),
            [
                'package-lock.json:package-lock.json:1',
                'package-lock.json:client/package-lock.json:1',
                'Dockerfile:Dockerfile:1',
                '.nvmrc:.nvmrc:1',
                'package.json:package.json:0'
            ]
        );
    });
});
