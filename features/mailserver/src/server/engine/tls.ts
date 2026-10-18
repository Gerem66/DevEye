import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';

import { now } from '../_shared';

/**
 * Le certificat des écouteurs, tenu en un seul endroit. Un certificat renouvelé
 * est poussé à chaque écouteur abonné, qui le sert dès la connexion suivante
 * sans refermer son port. Pas de `SNICallback` : un client qui n'envoie pas de
 * SNI (connexion par adresse IP, vieux client) doit recevoir le même certificat.
 */

export interface CertificateInfo {
    source: 'acme' | 'file';
    notAfter: number;
    staging: boolean;
}

export interface Pem {
    cert: string;
    key: string;
}

/** Une date de certificat en clair, pour l'opérateur. */
export function certificateDate(ts: number): string {
    return new Date(ts * 1000).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    });
}

/**
 * Ce qui empêche un client de faire confiance à ce certificat pour `hostname`,
 * en mots de l'opérateur ; vide s'il convient. Un PEM réduit au seul
 * certificat (`cert.pem` au lieu de `fullchain.pem`) échoue chez la plupart
 * des clients, qui ne vont pas chercher l'intermédiaire.
 */
export function certificateFlaws(certPem: string, hostname: string, at: number): string[] {
    const cert = new X509Certificate(certPem);
    const flaws: string[] = [];
    const notAfter = Math.floor(new Date(cert.validTo).getTime() / 1000);
    const notBefore = Math.floor(new Date(cert.validFrom).getTime() / 1000);
    if (notAfter <= at) flaws.push(`expiré depuis le ${certificateDate(notAfter)}`);
    else if (notBefore > at) flaws.push(`valide seulement à partir du ${certificateDate(notBefore)}`);
    if (hostname !== '' && cert.checkHost(hostname) === undefined) flaws.push(`ne couvre pas ${hostname}`);
    const chained = (certPem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length > 1;
    if (!chained && !cert.checkIssued(cert)) flaws.push('chaîne incomplète (fournir fullchain.pem)');
    return flaws;
}

export class TlsStore {
    private pem: Pem | null = null;
    private held: CertificateInfo | null = null;
    private readonly subscribers = new Set<(pem: Pem) => void>();
    lastError = '';

    constructor(private readonly hostname: string) {}

    current(): Pem | null {
        return this.pem;
    }

    info(): CertificateInfo | null {
        return this.held;
    }

    /**
     * Pose une paire PEM. Lève si elle ne se lit pas, ou si elle a un défaut
     * alors que celle en place n'en a pas : l'ancienne reste. Faute de mieux,
     * une paire défectueuse est servie, et `lastError` dit ses défauts.
     */
    set(pem: Pem, source: CertificateInfo['source'], staging = false, at = now()): void {
        // Construit pour rien d'autre que sa validation : clé et certificat doivent aller ensemble.
        tls.createSecureContext({ cert: pem.cert, key: pem.key });
        const flaws = certificateFlaws(pem.cert, this.hostname, at);
        if (flaws.length > 0 && this.pem && certificateFlaws(this.pem.cert, this.hostname, at).length === 0) {
            throw new Error(`Certificat refusé, l’actuel reste en place : ${flaws.join(', ')}`);
        }
        const notAfter = Math.floor(new Date(new X509Certificate(pem.cert).validTo).getTime() / 1000);
        this.pem = pem;
        this.held = { source, notAfter, staging };
        this.lastError = flaws.length > 0 ? `Certificat servi faute de mieux : ${flaws.join(', ')}` : '';
        for (const subscriber of this.subscribers) subscriber(pem);
    }

    /** Appelé à chaque certificat posé, le premier compris s'il arrive plus tard. */
    subscribe(subscriber: (pem: Pem) => void): () => void {
        this.subscribers.add(subscriber);
        return () => this.subscribers.delete(subscriber);
    }
}

export const TLS_MIN_VERSION = 'TLSv1.2' as const;
