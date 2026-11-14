import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isLockfile, parseLockfile } from './lockfiles';

/**
 * Les lecteurs de verrous, sans réseau ni disque. Chaque format a son piège,
 * et c'est celui-là que le cas vérifie, pas la lecture nominale.
 */

const find = (deps: ReturnType<typeof parseLockfile>, name: string) => deps.find((d) => d.name === name);

describe('isLockfile', () => {
    it('reconnaît un verrou à toute profondeur de l’arbre', () => {
        assert.equal(isLockfile('package-lock.json'), true);
        assert.equal(isLockfile('client/package-lock.json'), true);
        assert.equal(isLockfile('agent/Cargo.lock'), true);
        assert.equal(isLockfile('package.json'), false);
        assert.equal(isLockfile('src/Cargo.toml'), false);
    });
});

describe('package-lock.json', () => {
    it('lit le format v3 et écarte la racine comme les liens locaux', () => {
        const deps = parseLockfile(
            'package-lock.json',
            JSON.stringify({
                lockfileVersion: 3,
                packages: {
                    '': { name: 'app', version: '1.0.0' },
                    'node_modules/lodash': { version: '4.17.20' },
                    'node_modules/@scope/pkg': { version: '2.1.0' },
                    'node_modules/a/node_modules/b': { version: '0.3.0' },
                    'node_modules/local': { version: '1.0.0', link: true }
                }
            })
        );
        assert.equal(deps.length, 3);
        assert.equal(find(deps, 'lodash')?.version, '4.17.20');
        assert.equal(find(deps, '@scope/pkg')?.version, '2.1.0');
        // Le nom d'un paquet imbriqué est ce qui suit le DERNIER node_modules.
        assert.equal(find(deps, 'b')?.version, '0.3.0');
        assert.equal(find(deps, 'local'), undefined);
    });

    it('retombe sur l’arbre imbriqué du format v1', () => {
        const deps = parseLockfile(
            'package-lock.json',
            JSON.stringify({
                lockfileVersion: 1,
                dependencies: {
                    minimist: { version: '0.0.8' },
                    mkdirp: { version: '0.5.1', dependencies: { minimist: { version: '1.2.0' } } }
                }
            })
        );
        assert.equal(deps.length, 3);
        assert.ok(deps.some((d) => d.name === 'minimist' && d.version === '1.2.0'));
    });

    it('rend une liste vide sur un fichier tronqué plutôt que de lever', () => {
        assert.deepEqual(parseLockfile('package-lock.json', '{ "packages": '), []);
    });
});

describe('yarn.lock', () => {
    it('attribue la version à chacune des demandes de l’entrée', () => {
        const deps = parseLockfile(
            'yarn.lock',
            [
                '# yarn lockfile v1',
                '',
                '"lodash@^4.0.0", "lodash@^4.17.0":',
                '  version "4.17.21"',
                '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"',
                '',
                '"@scope/pkg@^1.0.0":',
                '  version "1.2.3"',
                ''
            ].join('\n')
        );
        // Les deux demandes de lodash décrivent le même paquet : le
        // dédoublonnage ne doit en laisser qu'un.
        assert.equal(deps.length, 2);
        assert.equal(find(deps, 'lodash')?.version, '4.17.21');
        assert.equal(find(deps, '@scope/pkg')?.version, '1.2.3');
    });
});

describe('pnpm-lock.yaml', () => {
    it('lit les deux formes que pnpm a écrites', () => {
        const deps = parseLockfile(
            'pnpm-lock.yaml',
            [
                'packages:',
                '',
                '  /lodash/4.17.21:',
                '    dev: false',
                '',
                "  '/@scope/pkg@1.2.3':",
                '    dev: true',
                ''
            ].join('\n')
        );
        assert.equal(find(deps, 'lodash')?.version, '4.17.21');
        assert.equal(find(deps, '@scope/pkg')?.version, '1.2.3');
    });
});

describe('Cargo.lock et poetry.lock', () => {
    it('ne retient que les tables [[package]]', () => {
        const deps = parseLockfile(
            'Cargo.lock',
            [
                'version = 3',
                '',
                '[[package]]',
                'name = "serde"',
                'version = "1.0.190"',
                '',
                '[[package]]',
                'name = "tokio"',
                'version = "1.35.0"',
                '',
                '[metadata]',
                'name = "pas-un-paquet"',
                'version = "9.9.9"'
            ].join('\n')
        );
        assert.equal(deps.length, 2);
        assert.equal(deps[0].ecosystem, 'crates.io');
        assert.equal(find(deps, 'pas-un-paquet'), undefined);
    });
});

describe('requirements.txt', () => {
    it('ne garde que les versions épinglées', () => {
        const deps = parseLockfile(
            'requirements.txt',
            ['Django==3.2.0', 'requests[security]==2.25.1', 'flask>=1.0  # une plage', '# commentaire', ''].join('\n')
        );
        assert.equal(deps.length, 2);
        assert.equal(find(deps, 'django')?.version, '3.2.0');
        assert.equal(find(deps, 'flask'), undefined);
    });
});

describe('go.sum', () => {
    it('ignore la ligne du go.mod, qui ne dirait rien de plus', () => {
        const deps = parseLockfile(
            'go.sum',
            ['github.com/gin-gonic/gin v1.7.0 h1:abcd=', 'github.com/gin-gonic/gin v1.7.0/go.mod h1:efgh='].join('\n')
        );
        assert.equal(deps.length, 1);
        assert.equal(deps[0].version, 'v1.7.0');
    });
});

describe('composer.lock et Gemfile.lock', () => {
    it('lit les paquets de production et de développement', () => {
        const deps = parseLockfile(
            'composer.lock',
            JSON.stringify({
                packages: [{ name: 'monolog/monolog', version: 'v2.3.5' }],
                'packages-dev': [{ name: 'phpunit/phpunit', version: '9.5.0' }]
            })
        );
        assert.equal(deps.length, 2);
        assert.equal(find(deps, 'monolog/monolog')?.version, '2.3.5');
    });

    it('ne lit que les gemmes de la section specs', () => {
        const deps = parseLockfile(
            'Gemfile.lock',
            [
                'GEM',
                '  remote: https://rubygems.org/',
                '  specs:',
                '    rack (2.2.3)',
                '    rails (6.1.4)',
                '      rack (>= 2.0)',
                '',
                'PLATFORMS',
                '  ruby'
            ].join('\n')
        );
        assert.equal(deps.length, 2);
        assert.equal(find(deps, 'rails')?.version, '6.1.4');
    });
});

describe('les verrous ajoutés', () => {
    const names = (path: string, text: string) =>
        parseLockfile(path, text).map((d) => `${d.ecosystem}:${d.name}@${d.version}`);

    it('lit bun, uv, Pipfile, pubspec, NuGet, Gradle, mix et SwiftPM', () => {
        assert.deepEqual(
            names(
                'bun.lock',
                '{\n  "packages": {\n    "lodash": ["lodash@4.17.21", "", {}, "sha512-x"],\n    "@scope/x": ["@scope/x@1.0.0", ""],\n    "app": ["app@workspace:."],\n  }\n}'
            ),
            ['npm:lodash@4.17.21', 'npm:@scope/x@1.0.0']
        );
        assert.deepEqual(names('uv.lock', '[[package]]\nname = "flask"\nversion = "3.0.0"\n'), ['PyPI:flask@3.0.0']);
        assert.deepEqual(
            names('Pipfile.lock', JSON.stringify({ default: { Django: { version: '==4.2.1' } }, develop: {} })),
            ['PyPI:django@4.2.1']
        );
        assert.deepEqual(names('pubspec.lock', 'packages:\n  http:\n    dependency: direct\n    version: "1.1.0"\n'), [
            'Pub:http@1.1.0'
        ]);
        assert.deepEqual(
            names(
                'packages.lock.json',
                JSON.stringify({ dependencies: { 'net8.0': { 'Newtonsoft.Json': { resolved: '13.0.1' } } } })
            ),
            ['NuGet:Newtonsoft.Json@13.0.1']
        );
        assert.deepEqual(
            names('gradle.lockfile', '# comment\ncom.google.guava:guava:31.1-jre=compileClasspath\nempty=\n'),
            ['Maven:com.google.guava:guava@31.1-jre']
        );
        assert.deepEqual(
            names('mix.lock', '%{\n  "plug": {:hex, :plug, "1.14.0", "abc", [:mix], [], "hexpm", "def"},\n}'),
            ['Hex:plug@1.14.0']
        );
        assert.deepEqual(
            names(
                'Package.resolved',
                JSON.stringify({
                    pins: [{ location: 'https://github.com/apple/swift-nio.git', state: { version: '2.60.0' } }]
                })
            ),
            ['SwiftURL:github.com/apple/swift-nio@2.60.0']
        );
    });

    it('lit la version de Go pour sa bibliothèque standard, quand elle est exacte', () => {
        assert.deepEqual(names('go.mod', 'module x\n\ngo 1.22\n\ntoolchain go1.22.3\n'), ['Go:stdlib@1.22.3']);
        assert.deepEqual(names('go.mod', 'module x\n\ngo 1.21.5\n'), ['Go:stdlib@1.21.5']);
        assert.deepEqual(names('go.mod', 'module x\n\ngo 1.21\n'), []);
    });

    it('lit les actions d’un workflow en version exacte, pas celles qui suivent les correctifs', () => {
        const wf = [
            'steps:',
            '  - uses: actions/checkout@v4',
            '  - uses: tj-actions/changed-files@v35.7.6',
            '  - uses: ./local'
        ].join('\n');
        assert.deepEqual(names('.github/workflows/ci.yml', wf), ['GitHub Actions:tj-actions/changed-files@35.7.6']);
        assert.equal(isLockfile('.github/workflows/ci.yml'), true);
        assert.equal(isLockfile('docs/ci.yml'), false);
    });
});
