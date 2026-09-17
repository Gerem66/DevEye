import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';

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

export class TlsStore {
    private pem: Pem | null = null;
    private held: CertificateInfo | null = null;
    private readonly subscribers = new Set<(pem: Pem) => void>();
    lastError = '';

    current(): Pem | null {
        return this.pem;
    }

    info(): CertificateInfo | null {
        return this.held;
    }

    /** Pose une paire PEM. Lève si elle ne se lit pas : l'ancienne reste alors en place. */
    set(pem: Pem, source: CertificateInfo['source'], staging = false): void {
        // Construit pour rien d'autre que sa validation : clé et certificat doivent aller ensemble.
        tls.createSecureContext({ cert: pem.cert, key: pem.key });
        const notAfter = Math.floor(new Date(new X509Certificate(pem.cert).validTo).getTime() / 1000);
        this.pem = pem;
        this.held = { source, notAfter, staging };
        this.lastError = '';
        for (const subscriber of this.subscribers) subscriber(pem);
    }

    /** Appelé à chaque certificat posé, le premier compris s'il arrive plus tard. */
    subscribe(subscriber: (pem: Pem) => void): () => void {
        this.subscribers.add(subscriber);
        return () => this.subscribers.delete(subscriber);
    }
}

export const TLS_MIN_VERSION = 'TLSv1.2' as const;
