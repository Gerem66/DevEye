import { createServer, type AddressInfo, type Server, type Socket } from 'net';
import { Client as SshClient } from 'ssh2';
import { SocksClient } from 'socks';
import type { DatabaseAccessKind, DatabaseSshAuth } from '../contracts/domain';

/**
 * Joindre une base qui n'est pas directement accessible.
 *
 * Deux chemins, parce qu'ils répondent à deux situations qui ne se recouvrent
 * pas : un rebond **SSH** quand on a un compte sur une machine du réseau, un
 * proxy **SOCKS5** quand un tunnel VPN est déjà monté ailleurs et expose un
 * point d'entrée. Le troisième cas — l'accès direct — ne passe pas par ici du
 * tout.
 *
 * ## Pourquoi un écouteur local plutôt qu'une socket passée au pilote
 *
 * `mysql2` accepte une socket existante, `pg` non — il veut ouvrir la sienne
 * vers un hôte et un port. Un petit écouteur sur `127.0.0.1:0` (port libre
 * choisi par le noyau) donne aux deux pilotes exactement ce qu'ils savent
 * consommer, sans rien supposer de leur implémentation. Le coût est une socket
 * de plus par connexion, le temps de la connexion.
 *
 * ## Fermeture
 *
 * Un tunnel est **toujours** rendu avec son `close()`, et l'appelant le ferme
 * dans un `finally`. Un tunnel oublié laisserait derrière lui un écouteur, une
 * session SSH et un descripteur — sur un relevé périodique, quelques heures
 * suffiraient à épuiser le processus.
 */

/** Un chemin ouvert vers l'hôte cible, et de quoi le refermer. */
export interface Tunnel {
    /** L'hôte à donner au pilote — l'écouteur local, ou l'hôte réel en direct. */
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

/** Ports par défaut, pour ne pas obliger à les saisir. */
const SSH_DEFAULT_PORT = 22;
const SOCKS_DEFAULT_PORT = 1080;

/** Au-delà, on renonce : un tunnel qui ne s'ouvre pas doit le dire vite. */
const CONNECT_TIMEOUT_MS = 12_000;

/** Un tunnel qui ne fait rien : l'accès direct, sous la même forme. */
function direct(host: string, port: number): Tunnel {
    return { host, port, close: async () => {} };
}

/**
 * Ouvre le chemin décrit par `config` vers `target`.
 *
 * Ne lève que des `Error` au message déjà lisible : c'est ce message que
 * l'utilisateur verra, et « ECONNREFUSED » ne lui apprend rien sur ce qu'il doit
 * corriger.
 */
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
 * Un écouteur local qui délègue chaque connexion entrante à `connect`.
 *
 * Le même squelette sert aux deux chemins : seule la façon d'obtenir la socket
 * distante change. Les erreurs d'une connexion **déjà établie** sont fatales à
 * cette connexion-là seulement — on détruit la socket cliente plutôt que de
 * laisser une exception non capturée abattre le processus.
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
        // `127.0.0.1` et non `0.0.0.0` : ce relais n'a aucune raison d'être
        // joignable depuis l'extérieur, et l'exposer ouvrirait un accès à la
        // base sans authentification.
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
            // La clé est passée en mémoire, jamais écrite sur disque — un
            // fichier de clé temporaire survivrait à un arrêt brutal.
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
                // `forwardOut` rend un canal SSH, qui expose l'interface d'un
                // flux duplex — c'est tout ce dont le relais a besoin.
                else resolve(stream as unknown as Socket);
            });
        });

    // Une première redirection tout de suite : c'est elle qui dit si le rebond
    // accepte d'atteindre la cible. Sans cela, une cible injoignable
    // n'apparaîtrait qu'au premier échec du pilote, avec un message bien moins
    // clair.
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

    // Même raison que côté SSH : on veut savoir tout de suite si le proxy
    // accepte la destination, et le dire avec ses mots.
    try {
        const probe = await connect();
        probe.destroy();
    } catch (e) {
        throw new Error(`Proxy SOCKS injoignable : ${e instanceof Error ? e.message : String(e)}`);
    }

    return localForwarder(connect, async () => {});
}
