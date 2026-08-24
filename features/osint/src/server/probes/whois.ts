import { connect } from 'net';

import { field, tag, type OsintProbeAdapter, type OsintTag } from './shared';

/**
 * WHOIS brut, en TCP sur le port 43.
 *
 * Aucune dépendance : le protocole tient en une phrase — on ouvre la connexion,
 * on envoie la requête suivie de CRLF, on lit jusqu'à la fermeture. Une
 * bibliothèque n'apporterait ici qu'une table de serveurs à maintenir.
 *
 * Servie **en plus** de RDAP, pas à sa place : le texte libre du registre porte
 * régulièrement ce que son RDAP omet — c'est vrai de l'AFNIC (`.fr`), qui y
 * publie le statut du titulaire et les dates de façon plus complète.
 */

const WHOIS_PORT = 43;
const WHOIS_TIMEOUT_MS = 6000;
const WHOIS_MAX_BYTES = 120_000;

function whoisQuery(host: string, query: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;

        const socket = connect({ host, port: WHOIS_PORT });
        socket.setTimeout(WHOIS_TIMEOUT_MS);

        const fail = (e: Error): void => {
            socket.destroy();
            reject(e);
        };

        socket.on('connect', () => socket.write(`${query}\r\n`));
        socket.on('data', (d: Buffer) => {
            chunks.push(d);
            total += d.length;
            // Un serveur bavard (ou hostile) ne doit pas pouvoir remplir la mémoire.
            if (total >= WHOIS_MAX_BYTES) socket.destroy();
        });
        socket.on('timeout', () => fail(new Error('Délai dépassé')));
        socket.on('error', fail);
        socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

/** Le serveur que l'IANA désigne pour ce TLD. */
function referralOf(text: string): string | null {
    const m = text.match(/^\s*(?:refer|whois):\s*(\S+)\s*$/im);
    return m ? m[1] : null;
}

/** Première valeur d'un champ, insensible à la casse et aux libellés multiples. */
function pick(text: string, ...labels: string[]): string | null {
    for (const label of labels) {
        const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, 'im');
        const m = text.match(re);
        if (m && m[1] && !/^(redacted|not disclosed|data protected)/i.test(m[1])) return m[1];
    }
    return null;
}

export const whoisProbe: OsintProbeAdapter = {
    id: 'whois',
    appliesTo: ['domain', 'url'],
    ttlMs: 60 * 60 * 1000,
    async run({ target }) {
        const domain = target.value;
        const tld = domain.slice(domain.lastIndexOf('.') + 1);

        // 1. L'IANA dit qui fait autorité sur ce TLD.
        const ianaText = await whoisQuery('whois.iana.org', tld);
        const server = referralOf(ianaText);
        if (!server) {
            return {
                status: 'empty',
                summary: `L'IANA n'annonce aucun serveur WHOIS pour « .${tld} ».`,
                raw: ianaText
            };
        }

        // 2. Le registre lui-même. Verisign veut « domain <nom> » pour éviter les
        //    correspondances partielles ; ailleurs le nom nu suffit.
        const query = /verisign|whois\.(com|net)$/i.test(server) ? `domain ${domain}` : domain;
        const text = await whoisQuery(server, query);

        if (!text.trim()) {
            return { status: 'empty', summary: `${server} n'a rien renvoyé.` };
        }
        if (/no match|not found|no entries found|no data found|pas d'objet/i.test(text)) {
            return {
                status: 'empty',
                summary: `${server} ne connaît pas « ${domain} » — le domaine semble libre.`,
                tags: [tag('Non enregistré', 'warn')],
                raw: text
            };
        }

        const fields = [field('Serveur interrogé', server, { mono: true })];
        const add = (label: string, ...keys: string[]): void => {
            const v = pick(text, ...keys);
            if (v) fields.push(field(label, v));
        };

        add("Bureau d'enregistrement", 'registrar', 'sponsoring registrar');
        add('Titulaire', 'registrant name', 'registrant', 'holder', 'org', 'organisation');
        add('Pays', 'registrant country', 'country');
        add('Créé le', 'creation date', 'created', 'registered on', 'registration date');
        add('Expire le', 'expiry date', 'registry expiry date', 'expires', 'expiration date');
        add('Modifié le', 'updated date', 'last-update', 'last modified');
        add('Contact abuse', 'registrar abuse contact email');

        const nameservers = [...text.matchAll(/^\s*(?:name server|nserver|nameserver)\s*:\s*(\S+)/gim)].map((m) =>
            m[1].toLowerCase()
        );
        const uniqueNs = [...new Set(nameservers)];
        if (uniqueNs.length) fields.push(field('Serveurs de noms', uniqueNs.join('\n'), { mono: true }));

        const tags: OsintTag[] = [];
        // Le WHOIS caviardé est la norme depuis le RGPD ; le signaler évite de
        // faire croire que le titulaire est réellement inconnu.
        if (/redacted|gdpr|data protected|not disclosed/i.test(text)) tags.push(tag('Caviardé (RGPD)', 'neutral'));
        if (/clientTransferProhibited/i.test(text)) tags.push(tag('Verrouillé', 'good'));
        if (/privacy|whoisguard|proxy protect|contact privacy/i.test(text)) {
            tags.push(tag('Anonymisation', 'warn'));
        }

        return {
            summary: `Enregistrement obtenu de ${server}.`,
            fields,
            tags,
            raw: text
        };
    }
};
