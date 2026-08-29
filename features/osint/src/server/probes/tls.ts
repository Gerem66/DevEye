import { connect, type PeerCertificate } from 'tls';

import { daysUntil, field, formatDate, tag, type OsintProbeAdapter, type OsintTag } from './shared';

/**
 * Certificat TLS présenté par le domaine. Le champ SAN énumère tous les noms
 * couverts : de l'infrastructure interne, publiée sans y penser.
 */

const TLS_TIMEOUT_MS = 6000;

/**
 * Un champ de sujet ou d'émetteur peut être multivalué (`O` répété dans le DN) :
 * Node rend alors un tableau. On n'affiche que la première valeur, la seule qui
 * porte l'identité.
 */
function first(v: string | string[] | undefined): string | null {
    if (Array.isArray(v)) return v[0] ?? null;
    return v ?? null;
}

function peerCertificate(host: string): Promise<PeerCertificate> {
    return new Promise((resolve, reject) => {
        const socket = connect({
            host,
            port: 443,
            servername: host,
            // On décrit le certificat, y compris invalide : un certificat expiré
            // ou auto-signé est ce qu'on cherche à voir. Validation faite ensuite.
            rejectUnauthorized: false,
            timeout: TLS_TIMEOUT_MS
        });

        const fail = (e: Error): void => {
            socket.destroy();
            reject(e);
        };

        socket.on('secureConnect', () => {
            const cert = socket.getPeerCertificate(false);
            const authorized = socket.authorized;
            const authError = socket.authorizationError;
            socket.end();
            if (!cert || Object.keys(cert).length === 0) {
                reject(new Error('Aucun certificat présenté'));
                return;
            }
            resolve(Object.assign(cert, { __authorized: authorized, __authError: authError }) as PeerCertificate);
        });
        socket.on('timeout', () => fail(new Error('Délai dépassé')));
        socket.on('error', fail);
    });
}

export const tlsProbe: OsintProbeAdapter = {
    id: 'tls',
    appliesTo: ['domain', 'url'],
    ttlMs: 60 * 60 * 1000,
    async run({ target }) {
        const cert = await peerCertificate(target.value);
        const extra = cert as PeerCertificate & { __authorized?: boolean; __authError?: Error };

        const fields = [];
        const cn = first(cert.subject?.CN);
        if (cn) fields.push(field('Nom commun', cn, { mono: true }));

        const issuer = first(cert.issuer?.O) ?? first(cert.issuer?.CN);
        if (issuer) fields.push(field('Émetteur', issuer));

        const from = formatDate(cert.valid_from);
        if (from) fields.push(field('Valide depuis', from));
        const to = formatDate(cert.valid_to);
        if (to) fields.push(field("Valide jusqu'au", to));

        // `asn1Curve` n'est présent que sur une clé elliptique : ce qui distingue
        // EC de RSA sans décoder la clé publique.
        const algo = cert.asn1Curve ? `EC (${cert.asn1Curve})` : 'RSA';
        if (extra.bits) fields.push(field('Clé', `${algo}, ${extra.bits} bits`));
        if (cert.fingerprint256) fields.push(field('Empreinte SHA-256', cert.fingerprint256, { mono: true }));
        if (cert.serialNumber) fields.push(field('Numéro de série', cert.serialNumber, { mono: true }));

        // Le SAN : la raison d'être de cette sonde.
        const sans = (cert.subjectaltname ?? '')
            .split(',')
            .map((s) => s.trim().replace(/^DNS:/, ''))
            .filter(Boolean);
        const others = sans.filter((s) => s !== target.value && s !== `www.${target.value}`);
        if (sans.length) {
            fields.push(field(`Noms couverts (${sans.length})`, sans.join('\n'), { mono: true }));
        }

        const tags: OsintTag[] = [];
        const remaining = daysUntil(cert.valid_to);
        if (remaining !== null) {
            if (remaining < 0) tags.push(tag('Certificat expiré', 'bad'));
            else if (remaining < 15) tags.push(tag(`Expire dans ${remaining} j`, 'bad'));
            else if (remaining < 30) tags.push(tag(`Expire dans ${remaining} j`, 'warn'));
            else tags.push(tag(`Expire dans ${remaining} j`, 'good'));
        }
        if (extra.__authorized === false && extra.__authError) {
            tags.push(tag(`Chaîne invalide : ${extra.__authError.message ?? extra.__authError}`, 'bad'));
        }
        if (issuer && /let's encrypt/i.test(issuer)) tags.push(tag("Let's Encrypt", 'neutral'));
        if (sans.some((s) => s.startsWith('*.'))) tags.push(tag('Joker', 'neutral'));
        // Le vrai butin : des noms que la cible n'annonçait pas.
        if (others.length > 0) tags.push(tag(`${others.length} autre(s) nom(s) révélé(s)`, 'warn'));

        return {
            summary: issuer ? `Certificat émis par ${issuer}.` : 'Certificat présenté.',
            fields,
            tags,
            links: others.slice(0, 12).map((name) => ({ label: name, href: `osint:domain/${name}` }))
        };
    }
};
