import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { eolProductOf, indexOf, parseDump, releaseFor } from './eol';

/** Les fins de vie : le dump tel qu'il arrive, la branche d'une version, la fiche d'un composant. */

export const DUMP = {
    result: [
        {
            name: 'postgresql',
            label: 'PostgreSQL',
            aliases: ['postgres'],
            identifiers: [{ type: 'cpe', id: 'cpe:/a:postgresql:postgresql' }],
            releases: [
                { name: '16', isEol: false, eolFrom: '2028-11-09', isMaintained: true, latest: { name: '16.4' } },
                { name: '13', isEol: true, eolFrom: '2025-11-13', isMaintained: false, latest: { name: '13.22' } }
            ]
        },
        {
            name: 'debian',
            label: 'Debian',
            aliases: [],
            identifiers: [],
            releases: [{ name: '10', isEol: true, eolFrom: '2022-09-10', isMaintained: false, latest: null }]
        },
        {
            name: 'angular',
            label: 'Angular',
            aliases: [],
            identifiers: [{ type: 'purl', id: 'pkg:npm/%40angular/core' }],
            releases: [{ name: '15', isEol: true, eolFrom: '2024-05-18', isMaintained: false, latest: null }]
        }
    ]
};

const index = indexOf(parseDump(DUMP));
const product = (ecosystem: string, name: string, version: string, extra = {}) => ({
    kind: 'product' as const,
    ecosystem,
    name,
    version,
    format: 'Dockerfile' as const,
    path: null,
    line: null,
    ...extra
});

describe('les fins de vie', () => {
    it('trouvent la branche d’une version par segments', () => {
        const pg = index.byName.get('postgresql')!;
        assert.equal(releaseFor(pg, '13.4')?.name, '13');
        assert.equal(releaseFor(pg, '13')?.name, '13');
        assert.equal(releaseFor(pg, '130.1'), null);
    });

    it('relient un outil, un système et un paquet déclaré à leur fiche', () => {
        assert.equal(eolProductOf(product('postgres', 'PostgreSQL', '13'), index)?.name, 'postgresql');
        assert.equal(eolProductOf(product('os', 'Debian GNU/Linux', '10'), index)?.name, 'debian');
        const angular = { ...product('npm', '@angular/core', '15.2.0'), kind: 'package' as const };
        assert.equal(eolProductOf({ ...angular, direct: true }, index)?.name, 'angular');
        assert.equal(eolProductOf(angular, index), null, 'une dépendance de dépendance ne compte pas');
    });
});
