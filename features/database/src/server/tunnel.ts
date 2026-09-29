import { connect as netConnect, createServer, type AddressInfo, type Server, type Socket } from 'net';
import type { Duplex } from 'stream';
import { Client as SshClient } from 'ssh2';
import { SocksClient } from 'socks';
import type { DatabaseAccessKind, DatabaseSshAuth } from '../contracts/domain';

// Le garde des connexions sortantes, partagé par toute l'app : la base, le
// rebond et le proxy sont saisis par un membre, et `publicLookup` referme la
// fenêtre entre la vérification et la connexion (rebinding DNS).
import {
    assertAllowedOutboundHost,
    OUTBOUND_HOST_REFUSED_MESSAGE,
    publicLookup,
    UnsafeTargetError
} from '@/Services/netFetch';

/**
 * Joindre une base, en direct, par un rebond SSH, par un proxy SOCKS5 ou par
 * l'agent d'un appareil. Un
 * écouteur local sur `127.0.0.1:0` plutôt qu'une socket passée au pilote : `pg`
 * n'en accepte pas, et `pg_dump` ne se connecte qu'à un hôte. Le direct y passe
 * aussi : sinon le pilote résoudrait le nom lui-même, hors du garde. Un tunnel
 * est toujours rendu avec son `close()`, que l'appelant appelle dans un
 * `finally` ; oublié, il laisse un écouteur et une session SSH.
 */

/** Un chemin ouvert vers l'hôte cible, et de quoi le refermer. */
export interface Tunnel {
    /** L'hôte à donner au pilote : toujours l'écouteur local. */
    host: string;
    port: number;
    close: () => Promise<void>;
}

/**
 * Une connexion ouverte par l'agent d'un appareil vers l'hôte de la base, de
 * son côté. Droits, présence et version de l'agent sont vérifiés avant.
 */
export type DeviceRelay = (target: { host: string; port: number }) => Promise<Duplex>;

export interface TunnelConfig {
    kind: DatabaseAccessKind;
    /** Hôte du rebond SSH ou du proxy SOCKS. */
    host: string;
    port: number | null;
    username: string;
    auth: DatabaseSshAuth;
    /** Mot de passe SSH ou clé privée ; jamais rendu au client. */
    secret: string | null;
    /** Le relais de l'appareil choisi, en mode `device`. */
    relay: DeviceRelay | null;
}

const SSH_DEFAULT_PORT = 22;
const SOCKS_DEFAULT_PORT = 1080;

const CONNECT_TIMEOUT_MS = 12_000;

/**
 * Une connexion TCP depuis le serveur vers un hôte saisi par un membre. Hors
 * `OUTBOUND_ALLOW_PRIVATE`, une adresse privée ou locale est refusée.
 */
async function guardedConnect(host: string, port: number): Promise<Socket> {
    await assertAllowedOutboundHost(host);
    return new Promise<Socket>((resolve, reject) => {
        const socket = netConnect({ host, port, lookup: publicLookup, timeout: CONNECT_TIMEOUT_MS });
        socket.once('connect', () => {
            socket.setTimeout(0);
            resolve(socket);
        });
        socket.once('timeout', () => {
            socket.destroy();
            reject(new Error(`${host}:${port} n’a pas répondu dans le délai imparti.`));
        });
        socket.once('error', (e: NodeJS.ErrnoException) =>
            reject(e.code === 'ENOTPUBLIC' ? new UnsafeTargetError(OUTBOUND_HOST_REFUSED_MESSAGE) : e)
        );
    });
}

/** Ouvre le chemin décrit par `config` vers `target` ; ne lève que des messages lisibles. */
export async function openTunnel(config: TunnelConfig, target: { host: string; port: number }): Promise<Tunnel> {
    if (config.kind === 'direct') return openDirect(target);
    if (config.kind === 'device') return openDeviceTunnel(config.relay, target);
    if (config.host.trim() === '') {
        throw new Error(
            config.kind === 'ssh'
                ? 'Aucun hôte de rebond SSH n’est renseigné.'
                : 'Aucun hôte de proxy SOCKS n’est renseigné.'
        );
    }
    return config.kind === 'ssh' ? openSshTunnel(config, target) : openSocksTunnel(config, target);
}

/**
 * Un écouteur local qui délègue chaque connexion entrante à `connect`. Une
 * erreur sur une connexion établie ne détruit que celle-ci, jamais le processus.
 */
async function localForwarder(connect: () => Promise<Socket>, onClose: () => Promise<void>): Promise<Tunnel> {
    const server: Server = createServer((client) => {
        void (async () => {
            try {
                const remote = await connect();
                client.pipe(remote);
                remote.pipe(client);
                const drop = () => {
                    client.destroy();
                    remote.destroy();
                };
                client.on('error', drop);
                remote.on('error', drop);
                remote.on('close', () => client.destroy());
            } catch {
                client.destroy();
            }
        })();
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        // `127.0.0.1` et non `0.0.0.0` : exposé, ce relais ouvrirait un accès
        // à la base sans authentification.
        server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address() as AddressInfo;
    return {
        host: '127.0.0.1',
        port: address.port,
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await onClose();
        }
    };
}

async function openDirect(target: { host: string; port: number }): Promise<Tunnel> {
    const connect = () => guardedConnect(target.host, target.port);
    // Un refus ou une base injoignable se disent ici : derrière le relais, le
    // pilote ne verrait qu'une connexion coupée.
    const probe = await connect();
    probe.destroy();
    return localForwarder(connect, async () => {});
}

/** Pas de garde du serveur : la cible est sur le réseau de l'appareil, que borne son agent. */
async function openDeviceTunnel(relay: DeviceRelay | null, target: { host: string; port: number }): Promise<Tunnel> {
    if (!relay) throw new Error('Aucun appareil n’est choisi pour joindre cette base.');
    // Un flux duplex, comme un canal SSH : tout ce dont le relais local a besoin.
    const connect = async () => (await relay(target)) as unknown as Socket;
    const probe = await connect();
    probe.destroy();
    return localForwarder(connect, async () => {});
}

async function openSshTunnel(config: TunnelConfig, target: { host: string; port: number }): Promise<Tunnel> {
    let sock: Socket;
    try {
        sock = await guardedConnect(config.host, config.port ?? SSH_DEFAULT_PORT);
    } catch (e) {
        if (e instanceof UnsafeTargetError) throw e;
        throw new Error(`Rebond SSH impossible : ${e instanceof Error ? e.message : String(e)}`);
    }
    const client = new SshClient();

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            client.destroy();
            reject(new Error(`Le rebond SSH ${config.host} n’a pas répondu dans le délai imparti.`));
        }, CONNECT_TIMEOUT_MS);

        client.once('ready', () => {
            clearTimeout(timer);
            resolve();
        });
        client.once('error', (e: Error) => {
            clearTimeout(timer);
            reject(new Error(`Rebond SSH impossible : ${e.message}`));
        });

        client.connect({
            sock,
            username: config.username,
            // La clé reste en mémoire, jamais écrite sur disque.
            ...(config.auth === 'key'
                ? { privateKey: config.secret ?? undefined }
                : { password: config.secret ?? undefined }),
            readyTimeout: CONNECT_TIMEOUT_MS
        });
    });

    const connect = () =>
        new Promise<Socket>((resolve, reject) => {
            client.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) => {
                if (err) reject(new Error(`Le rebond SSH a refusé la redirection : ${err.message}`));
                // Un canal SSH expose l'interface d'un flux duplex : tout ce
                // dont le relais a besoin.
                else resolve(stream as unknown as Socket);
            });
        });

    // Une première redirection tout de suite : une cible injoignable se dit
    // ici, avec les mots du rebond, pas au premier échec du pilote.
    const probe = await connect();
    probe.destroy();

    return localForwarder(connect, async () => {
        client.end();
    });
}

async function openSocksTunnel(config: TunnelConfig, target: { host: string; port: number }): Promise<Tunnel> {
    const proxy = {
        host: config.host,
        port: config.port ?? SOCKS_DEFAULT_PORT,
        type: 5 as const,
        ...(config.username ? { userId: config.username, password: config.secret ?? '' } : {})
    };

    // La destination est résolue par le proxy, de son côté : seul le proxy
    // lui-même passe par le garde.
    const connect = async (): Promise<Socket> => {
        const existing = await guardedConnect(proxy.host, proxy.port);
        try {
            const { socket } = await SocksClient.createConnection({
                proxy,
                command: 'connect',
                destination: { host: target.host, port: target.port },
                timeout: CONNECT_TIMEOUT_MS,
                existing_socket: existing
            });
            return socket;
        } catch (e) {
            existing.destroy();
            throw e;
        }
    };

    // Même raison que côté SSH : savoir tout de suite si le proxy accepte la
    // destination.
    try {
        const probe = await connect();
        probe.destroy();
    } catch (e) {
        if (e instanceof UnsafeTargetError) throw e;
        throw new Error(`Proxy SOCKS injoignable : ${e instanceof Error ? e.message : String(e)}`);
    }

    return localForwarder(connect, async () => {});
}
