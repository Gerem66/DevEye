import type { Readable } from 'node:stream';

import type { SMTPServer } from 'smtp-server';

import { TLS_MIN_VERSION, type TlsStore } from '../engine/tls';

/** Une réponse SMTP de refus, que `smtp-server` lit sur l'erreur qu'on lui rend. */
export function smtpError(responseCode: number, message: string): Error {
    return Object.assign(new Error(message), { responseCode });
}

/** Tout le message en mémoire, borné par le plafond du serveur : `null` s'il le dépasse. */
export async function collect(stream: Readable & { sizeExceeded?: boolean }, maxBytes: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
        size += (chunk as Buffer).length;
        // Au-delà, on continue de lire pour vider la connexion, sans plus rien garder.
        if (size <= maxBytes) chunks.push(chunk as Buffer);
    }
    return stream.sizeExceeded || size > maxBytes ? null : Buffer.concat(chunks);
}

/** Ouvre le port et rend celui qui a été pris (utile quand on demande `0`). */
export function listen(server: SMTPServer, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
            server.off('error', reject);
            const address = server.server.address();
            resolve(typeof address === 'object' && address ? address.port : port);
        });
    });
}

export function close(server: SMTPServer): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

/** Les options TLS d'un écouteur, et l'abonnement qui lui pousse un certificat renouvelé. */
export function tlsOptions(certificates: TlsStore): {
    key?: string;
    cert?: string;
    minVersion: typeof TLS_MIN_VERSION;
} {
    const pem = certificates.current();
    return pem ? { key: pem.key, cert: pem.cert, minVersion: TLS_MIN_VERSION } : { minVersion: TLS_MIN_VERSION };
}

export function followCertificate(server: SMTPServer, certificates: TlsStore): () => void {
    return certificates.subscribe((pem) =>
        server.updateSecureContext({ key: pem.key, cert: pem.cert, minVersion: TLS_MIN_VERSION })
    );
}

/** `Received:` tel que les MTA l'écrivent, sur des lignes repliées. */
export function receivedHeader(input: {
    helo: string;
    ip: string;
    hostname: string;
    protocol: string;
    id: string;
    recipient?: string;
}): string {
    const forPart = input.recipient ? `\r\n\tfor <${input.recipient}>` : '';
    return (
        `Received: from ${input.helo || 'unknown'} ([${input.ip}])\r\n` +
        `\tby ${input.hostname} with ${input.protocol} id ${input.id}${forPart};\r\n` +
        `\t${new Date().toUTCString().replace('GMT', '+0000')}\r\n`
    );
}
