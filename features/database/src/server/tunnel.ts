import { createServer, type AddressInfo, type Server, type Socket } from 'net';
import { Client as SshClient } from 'ssh2';
import { SocksClient } from 'socks';
import type { DatabaseAccessKind, DatabaseSshAuth } from '../contracts/domain';

/**
 * Joindre une base par un rebond SSH ou un proxy SOCKS5. Un écouteur local sur
 * `127.0.0.1:0` plutôt qu'une socket passée au pilote : `pg` n'en accepte pas.
 * Un tunnel est toujours rendu avec son `close()`, que l'appelant appelle dans
 * un `finally` ; oublié, il laisse un écouteur et une session SSH.
 */

/** Un chemin ouvert vers l'hôte cible, et de quoi le refermer. */
export interface Tunnel {
    /** L'hôte à donner au pilote : l'écouteur local, ou l'hôte réel en direct. */
    host: string;
    port: number;
    close: () => Promise<void>;
}

export interface TunnelConfig {
    kind: DatabaseAccessKind;
    /** Hôte du rebond SSH ou du proxy SOCKS. */
    host: string;
    port: number | null;
    username: string;
    auth: DatabaseSshAuth;
    /** Mot de passe SSH ou clé privée ; jamais rendu au client. */
    secret: string | null;
}

const SSH_DEFAULT_PORT = 22;
const SOCKS_DEFAULT_PORT = 1080;

const CONNECT_TIMEOUT_MS = 12_000;

/** Un tunnel qui ne fait rien : l'accès direct, sous la même forme. */
function direct(host: string, port: number): Tunnel {
    return { host, port, close: async () => {} };
}

/** Ouvre le chemin décrit par `config` vers `target` ; ne lève que des messages lisibles. */
export async function openTunnel(config: TunnelConfig, target: { host: string; port: number }): Promise<Tunnel> {
    if (config.kind === 'direct') return direct(target.host, target.port);
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

async function openSshTunnel(config: TunnelConfig, target: { host: string; port: number }): Promise<Tunnel> {
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
            host: config.host,
            port: config.port ?? SSH_DEFAULT_PORT,
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

    const connect = async (): Promise<Socket> => {
        const { socket } = await SocksClient.createConnection({
            proxy,
            command: 'connect',
            destination: { host: target.host, port: target.port },
            timeout: CONNECT_TIMEOUT_MS
        });
        return socket;
    };

    // Même raison que côté SSH : savoir tout de suite si le proxy accepte la
    // destination.
    try {
        const probe = await connect();
        probe.destroy();
    } catch (e) {
        throw new Error(`Proxy SOCKS injoignable : ${e instanceof Error ? e.message : String(e)}`);
    }

    return localForwarder(connect, async () => {});
}
