import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import type { DeviceRelay } from '@deveye/types/sdk/server';

import { OUTBOUND_REFUSED_MESSAGE } from '@/Services/netFetch';
import { fetchDeploymentLog, listTargets, type DokployInstance } from './dokploy';
import { ProviderError } from './types';

/**
 * Une instance jointe par l'agent d'un appareil. Le serveur d'essai écoute sur
 * la boucle locale, que le garde des appels sortants refuse : c'est le relais
 * qui doit passer, et lui seul. Le relais d'essai ouvre une socket locale, ce
 * que l'agent ferait depuis la machine.
 */

let server: Server;
let wss: WebSocketServer;
let port = 0;
/** Ce que la prochaine requête tRPC recevra. */
let answer: { status: number; body?: unknown; location?: string } = { status: 200 };
let seenHeaders: Record<string, string | string[] | undefined> = {};

const CATALOG = {
    result: {
        data: {
            json: [
                {
                    projectId: 'p1',
                    name: 'Site',
                    environments: [
                        {
                            environmentId: 'e1',
                            name: 'production',
                            applications: [{ applicationId: 'a1', name: 'web' }],
                            compose: []
                        }
                    ]
                }
            ]
        }
    }
};

before(async () => {
    server = createServer((req, res) => {
        seenHeaders = req.headers;
        if (answer.location) res.setHeader('location', answer.location);
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
    });
    wss = new WebSocketServer({ server });
    wss.on('connection', (socket) => {
        socket.send('journal relayé\n');
        socket.close();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
});

after(async () => {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    answer = { status: 200, body: CATALOG };
});

function instanceWith(relay: DeviceRelay | null): DokployInstance {
    return { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'clé', relay };
}

/** Le relais d'un appareil dont la machine porte le serveur d'essai. */
function localRelay(): { relay: DeviceRelay; targets: { host: string; port: number }[] } {
    const targets: { host: string; port: number }[] = [];
    const relay: DeviceRelay = async (target) => {
        targets.push(target);
        return netConnect(target);
    };
    return { relay, targets };
}

describe('Dokploy par un appareil', () => {
    it('joint l’instance par le relais, avec la clé, là où le serveur la refuserait', async () => {
        const { relay, targets } = localRelay();
        const found = await listTargets(instanceWith(relay));
        assert.deepEqual(
            found.map((t) => [t.kind, t.externalId, t.path]),
            [['application', 'a1', 'Site / production']]
        );
        assert.equal(seenHeaders['x-api-key'], 'clé');
        assert.ok(targets.length >= 1, 'le relais a été sollicité');
        assert.deepEqual(targets[0], { host: '127.0.0.1', port });

        await assert.rejects(listTargets(instanceWith(null)), (e: unknown) => {
            assert.ok(e instanceof ProviderError);
            assert.equal(e.message, OUTBOUND_REFUSED_MESSAGE);
            return true;
        });
    });

    it('ne suit pas une redirection : hors du garde, elle mènerait où l’instance veut', async () => {
        answer = { status: 302, location: 'http://169.254.169.254/latest/meta-data/' };
        const { relay } = localRelay();
        await assert.rejects(listTargets(instanceWith(relay)), (e: unknown) => {
            assert.ok(e instanceof ProviderError);
            assert.equal(e.status, 302);
            assert.match(e.message, /redirige/);
            return true;
        });
    });

    it('dit pourquoi le relais ne s’ouvre pas, dans les mots de l’agent', async () => {
        const relay: DeviceRelay = async () => {
            throw new Error('L’appareil « Serveur » est hors ligne.');
        };
        await assert.rejects(listTargets(instanceWith(relay)), (e: unknown) => {
            assert.ok(e instanceof ProviderError);
            assert.equal(e.message, 'L’appareil « Serveur » est hors ligne.');
            return true;
        });
    });

    it('rejoue le journal par le relais', async () => {
        const { relay, targets } = localRelay();
        const log = await fetchDeploymentLog(instanceWith(relay), '/un/chemin', { timeoutMs: 5_000 });
        assert.equal(log, 'journal relayé\n');
        assert.ok(targets.length >= 1, 'le relais a été sollicité');

        await assert.rejects(fetchDeploymentLog(instanceWith(null), '/un/chemin', { timeoutMs: 5_000 }));
    });
});
