import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { Logger } from 'pino';

import { createGeoIp, editionOf } from './geoip';

const quiet = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

describe('editionOf', () => {
    it('rend le mois courant et les précédents, année comprise', () => {
        const at = new Date(Date.UTC(2026, 0, 3));
        assert.equal(editionOf(at, 0), '2026-01');
        assert.equal(editionOf(at, 1), '2025-12');
    });
});

describe('geoip', () => {
    it('cherche l’édition du mois, puis celle d’avant, et dit l’échec', async () => {
        const asked: string[] = [];
        const geo = createGeoIp({
            clock: () => new Date(Date.UTC(2026, 9, 2)),
            download: (url) => {
                asked.push(url);
                return Promise.reject(new Error('404'));
            }
        });
        geo.init({ logger: quiet, enabled: true });
        assert.equal(await geo.refresh(), false);
        assert.deepEqual(asked, [
            'https://download.db-ip.com/free/dbip-country-lite-2026-10.mmdb.gz',
            'https://download.db-ip.com/free/dbip-country-lite-2026-09.mmdb.gz'
        ]);
        assert.equal(geo.state().edition, null);
        assert.equal(geo.state().error, '404');
    });

    it('refuse un fichier qui n’est pas une base, et ne répond rien tant qu’elle manque', async () => {
        const geo = createGeoIp({ download: () => Promise.resolve(gzipSync(Buffer.from('pas une base'))) });
        geo.init({ logger: quiet, enabled: true });
        assert.equal(await geo.refresh(), false);
        assert.notEqual(geo.state().error, null);
        assert.equal(geo.country('8.8.8.8'), null);
    });

    it('ne télécharge rien sans module qui le demande', () => {
        let calls = 0;
        const geo = createGeoIp({
            download: () => {
                calls += 1;
                return Promise.reject(new Error('jamais'));
            }
        });
        geo.init({ logger: quiet, enabled: false });
        geo.start();
        geo.stop();
        assert.equal(calls, 0);
        assert.equal(geo.state().enabled, false);
    });
});
