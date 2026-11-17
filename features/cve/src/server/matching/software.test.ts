import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { indexOf, parseDump } from './eol';
import { branchesFor, findSoftware, parseSoftwareQuery, searchSoftware } from './software';

/** La recherche d'un logiciel : ce que la requête veut dire, qui elle nomme, quelle branche. */

const release = (name: string) => ({ name, isEol: false, eolFrom: null, isMaintained: true, latest: null });
const product = (name: string, label: string, aliases: string[], releases: string[]) => ({
    name,
    label,
    aliases,
    identifiers: [],
    releases: releases.map(release)
});

const index = indexOf(
    parseDump({
        result: [
            product('nodejs', 'Node.js', ['node'], ['22', '20', '18']),
            product('python', 'Python', [], ['3.12', '3.11']),
            product('php', 'PHP', [], ['8.3', '8.2']),
            product('ubuntu', 'Ubuntu', [], ['24.04', '22.10', '22.04']),
            product('windows', 'Microsoft Windows', [], ['11-24h2-e', '11-23h2-w', '10-22h2']),
            product('postgresql', 'PostgreSQL', ['postgres'], ['16', '13']),
            product('log4j', 'Apache Log4j', [], ['2']),
            product('apache-http-server', 'Apache HTTP Server', [], ['2.4']),
            product('tomcat', 'Apache Tomcat', [], ['10.1']),
            product('kubernetes-node-feature-discovery', 'Kubernetes Node Feature Discovery', [], ['0.17']),
            product('windows-server', 'Microsoft Windows Server', [], ['2022', '2019'])
        ]
    })
);

describe('la recherche d’un logiciel', () => {
    it('lit un nom et une version de toutes les façons courantes', () => {
        assert.deepEqual(parseSoftwareQuery('node 18'), [
            { name: 'node', version: '18' },
            { name: 'node 18', version: null }
        ]);
        assert.deepEqual(parseSoftwareQuery('node@v18.19.0'), [{ name: 'node', version: '18.19.0' }]);
        assert.deepEqual(parseSoftwareQuery('python3.11').at(-1), { name: 'python', version: '3.11' });
        assert.deepEqual(parseSoftwareQuery('log4j'), [{ name: 'log4j', version: null }]);
        assert.deepEqual(parseSoftwareQuery('CVE-2021-44228'), [], 'une CVE ne nomme aucun logiciel');
    });

    it('trouve par le nom, l’alias, le libellé ou le nom d’un outil de la veille', () => {
        assert.equal(findSoftware(index, 'node')[0]?.name, 'nodejs');
        assert.equal(findSoftware(index, 'Node.js')[0]?.name, 'nodejs');
        assert.equal(findSoftware(index, 'postgres')[0]?.name, 'postgresql');
        assert.equal(findSoftware(index, 'httpd')[0]?.name, 'apache-http-server');
        assert.deepEqual(
            findSoftware(index, 'apache').map((p) => p.name),
            ['log4j', 'tomcat', 'apache-http-server'],
            'les plus courts d’abord parmi ce qui commence pareil'
        );
        assert.deepEqual(findSoftware(index, 'x'), [], 'une lettre ne cherche rien');
        assert.deepEqual(
            findSoftware(index, 'node').map((p) => p.name),
            ['nodejs'],
            'un nom exact écarte ce qui ne fait que le contenir'
        );
    });

    it('rend la branche d’une version, ou celles qui commencent par elle', () => {
        const { products, version } = searchSoftware(index, 'ubuntu 22.04');
        assert.equal(version, '22.04');
        assert.deepEqual(branchesFor(products[0], '22.04'), ['22.04']);
        assert.deepEqual(branchesFor(products[0], '22'), ['22.10', '22.04']);
        assert.deepEqual(branchesFor(index.byName.get('windows')!, '11'), ['11-24h2-e', '11-23h2-w']);
        assert.deepEqual(branchesFor(index.byName.get('nodejs')!, '18.19.0'), ['18']);
        assert.deepEqual(branchesFor(index.byName.get('nodejs')!, '19'), []);
    });

    it('essaie le nom collé à sa version quand le nom entier ne trouve rien', () => {
        const first = (query: string) => {
            const found = searchSoftware(index, query);
            return [found.products[0]?.name, found.version];
        };
        assert.deepEqual(first('python3.11'), ['python', '3.11']);
        assert.deepEqual(first('log4j'), ['log4j', null]);
        assert.deepEqual(first('node18'), ['nodejs', '18']);
    });

    it('ne garde que les logiciels qui ont la branche demandée', () => {
        assert.deepEqual(
            findSoftware(index, 'windows').map((p) => p.name),
            ['windows', 'windows-server']
        );
        assert.deepEqual(
            searchSoftware(index, 'windows 11').products.map((p) => p.name),
            ['windows']
        );
        assert.deepEqual(
            searchSoftware(index, 'windows 7').products.map((p) => p.name),
            ['windows', 'windows-server'],
            'aucun n’a la branche : tous restent, le tableau dira lesquelles existent'
        );
    });
});
