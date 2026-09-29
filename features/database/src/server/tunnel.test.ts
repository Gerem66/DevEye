import assert from 'node:assert/strict';
import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, it } from 'node:test';

// Le garde des connexions sortantes est celui de l'app : le test en ouvre la
// boucle locale le temps d'un cas, comme une installation personnelle.
import { OUTBOUND_HOST_REFUSED_MESSAGE, setAllowPrivateForTest, UnsafeTargetError } from '@/Services/netFetch';
import { openTunnel, type TunnelConfig } from './tunnel';

const DIRECT: TunnelConfig = {
    kind: 'direct',
    host: '',
    port: null,
    username: '',
    auth: 'password',
    secret: null,
    relay: null
};

const refused = (e: unknown) => e instanceof UnsafeTargetError && e.message === OUTBOUND_HOST_REFUSED_MESSAGE;

/** Un serveur qui renvoie ce qu'il reçoit, à la place d'une base. */
async function echoServer(): Promise<Server> {
    const server = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    return server;
}

afterEach(() => setAllowPrivateForTest(false));

describe('openTunnel sous le garde des adresses privées', () => {
    it('refuse une base en boucle locale ou sur le réseau privé', async () => {
        await assert.rejects(openTunnel(DIRECT, { host: '127.0.0.1', port: 3306 }), refused);
        await assert.rejects(openTunnel(DIRECT, { host: '10.0.0.5', port: 5432 }), refused);
        await assert.rejects(openTunnel(DIRECT, { host: 'localhost', port: 3306 }), refused);
    });

    it('refuse un rebond SSH ou un proxy SOCKS privé, quelle que soit la cible', async () => {
        const target = { host: 'db.example.com', port: 5432 };
        await assert.rejects(openTunnel({ ...DIRECT, kind: 'ssh', host: '192.168.1.10', port: 22 }, target), refused);
        await assert.rejects(openTunnel({ ...DIRECT, kind: 'socks', host: '127.0.0.1', port: 1080 }, target), refused);
    });

    it('par un appareil, la cible est celle de la machine : le garde du serveur ne s’en mêle pas', async () => {
        const server = await echoServer();
        const { port } = server.address() as AddressInfo;
        const asked: { host: string; port: number }[] = [];
        const tunnel = await openTunnel(
            {
                ...DIRECT,
                kind: 'device',
                relay: async (target) => {
                    asked.push(target);
                    return connect({ host: '127.0.0.1', port });
                }
            },
            { host: '127.0.0.1', port: 5432 }
        );
        await tunnel.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        assert.deepEqual(asked, [{ host: '127.0.0.1', port: 5432 }]);
        await assert.rejects(
            openTunnel({ ...DIRECT, kind: 'device' }, { host: '127.0.0.1', port: 5432 }),
            /Aucun appareil/
        );
    });

    it('relaie une base locale quand l’instance ouvre son réseau privé', async () => {
        setAllowPrivateForTest(true);
        const server = await echoServer();
        const { port } = server.address() as AddressInfo;
        const tunnel = await openTunnel(DIRECT, { host: '127.0.0.1', port });
        try {
            const echoed = await new Promise<string>((resolve, reject) => {
                const socket = connect({ host: tunnel.host, port: tunnel.port }, () => socket.write('ping'));
                socket.once('data', (chunk) => {
                    socket.destroy();
                    resolve(chunk.toString());
                });
                socket.once('error', reject);
            });
            assert.equal(echoed, 'ping');
        } finally {
            await tunnel.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
