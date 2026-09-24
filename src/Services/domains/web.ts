import { isIP } from 'node:net';
import { connect } from 'node:tls';

import type { SdkDomainProbe } from '@deveye/types/sdk/server';

import { resolveAddresses } from './dns';

/**
 * Ce que le socle vérifie lui-même sur un domaine web, avant la sonde du
 * module : le nom pointe vers DevEye, puis y répond en HTTPS avec un certificat
 * valable pour lui. Chaque étage a sa phrase, là où une requête HTTP ratée ne
 * dirait que « fetch failed ».
 */

const TLS_TIMEOUT_MS = 8_000;

/** Les codes d'une poignée de main qui aboutit sur un certificat qui ne vaut pas pour ce nom. */
const CERTIFICATE_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID'
]);

/** Un échec qui n'en est pas un : le certificat est demandé, il arrive. */
export type WebCheck = SdkDomainProbe | { ok: false; error: string; pending: true };

export interface WebSeam {
    addresses(name: string): Promise<string[]>;
    /** `null` quand la poignée de main aboutit sur un certificat valable pour `host`, son code d'erreur sinon. */
    handshake(host: string): Promise<string | null>;
}

function tlsHandshake(host: string): Promise<string | null> {
    return new Promise((resolve) => {
        const socket = connect({ host, port: 443, servername: host, timeout: TLS_TIMEOUT_MS });
        const done = (code: string | null): void => {
            socket.destroy();
            resolve(code);
        };
        socket.once('secureConnect', () => done(null));
        socket.once('timeout', () => done('ETIMEDOUT'));
        socket.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? 'ERROR'));
    });
}

export const systemWeb: WebSeam = { addresses: resolveAddresses, handshake: tlsHandshake };

/**
 * Le nom mène-t-il au même endroit que l'origine publique ? Une origine dont les
 * adresses sont illisibles (`localhost` en développement) ne tranche rien.
 */
export async function pointsHere(host: string, originHost: string, seam: WebSeam): Promise<boolean> {
    const [mine, theirs] = await Promise.all([
        seam.addresses(host),
        isIP(originHost) ? Promise.resolve([originHost]) : seam.addresses(originHost)
    ]);
    if (theirs.length === 0) return true;
    const target = new Set(theirs);
    return mine.some((address) => target.has(address));
}

/**
 * `null` quand le nom est prêt pour la sonde du module. `auto` : le proxy
 * obtient seul les certificats, donc un certificat absent sur un nom jamais
 * vérifié n'est qu'une attente.
 */
export async function webCheck(
    host: string,
    opts: { originHost: string; auto: boolean; verified: boolean },
    seam: WebSeam = systemWeb
): Promise<WebCheck | null> {
    if (!(await pointsHere(host, opts.originHost, seam))) {
        return {
            ok: false,
            error: 'Le domaine ne pointe pas encore vers DevEye : l’enregistrement CNAME est absent, ou ne vise pas la bonne adresse.'
        };
    }
    const code = await seam.handshake(host);
    if (code === null) return null;
    if (!CERTIFICATE_CODES.has(code)) {
        return { ok: false, error: 'Le domaine pointe bien vers DevEye, mais n’y répond pas en HTTPS.' };
    }
    if (!opts.auto) {
        return {
            ok: false,
            error: 'Le serveur qui héberge DevEye n’a pas de certificat HTTPS pour ce nom : son administrateur doit l’ajouter au proxy.'
        };
    }
    if (opts.verified) return { ok: false, error: 'Le certificat HTTPS de ce nom n’est plus valable.' };
    return {
        ok: false,
        pending: true,
        error: 'Certificat HTTPS en cours d’obtention : comptez quelques minutes, DevEye revérifie tout seul.'
    };
}
