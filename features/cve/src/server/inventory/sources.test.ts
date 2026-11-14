import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { databaseComponent, deviceComponents, parseImageRef } from './sources';

/** Ce que les sources sans fichiers apprennent à la veille : une image, une version de serveur, un appareil. */

describe('les références d’images', () => {
    it('séparent le nom de l’étiquette, registre et empreinte écartés', () => {
        assert.deepEqual(parseImageRef('docker.io/library/nginx:1.25.3@sha256:abc'), { name: 'nginx', tag: '1.25.3' });
        assert.deepEqual(parseImageRef('ghcr.io/org/app:2.0'), { name: 'app', tag: '2.0' });
        assert.deepEqual(parseImageRef('localhost:5000/redis'), { name: 'redis', tag: null });
    });
});

describe('le serveur d’une base', () => {
    it('reconnaît MySQL, MariaDB et PostgreSQL à ce qu’ils répondent', () => {
        assert.equal(databaseComponent('mysql', '8.0.36')?.ecosystem, 'mysql');
        assert.deepEqual(
            [databaseComponent('mysql', '10.11.6-MariaDB-0ubuntu0.24.04.1')].map(
                (c) => `${c?.ecosystem}@${c?.version}`
            ),
            ['mariadb@10.11.6']
        );
        assert.equal(
            databaseComponent('postgres', 'PostgreSQL 16.2 on x86_64-pc-linux-gnu, compiled by gcc')?.version,
            '16.2'
        );
        assert.equal(databaseComponent('mysql', 'inconnue'), null);
    });
});

describe('un appareil', () => {
    it('donne son système, son moteur et l’image de chaque conteneur à version exacte', () => {
        const components = deviceComponents({
            os: { name: 'Debian GNU/Linux', version: '12' },
            engines: [{ engine: 'docker', version: '27.1.1' }],
            containers: [
                { name: 'web', image: 'nginx:1.25.3', composeProject: 'site', composeService: 'web' },
                { name: 'cache', image: 'redis:7', composeProject: null, composeService: null }
            ]
        });
        assert.deepEqual(
            components.map((c) => `${c.format}:${c.ecosystem}@${c.version}:${c.path ?? ''}`),
            ['device-os:os@12:', 'container-engine:docker@27.1.1:', 'container-image:nginx@1.25.3:web (site/web)']
        );
    });
});
