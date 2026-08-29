import { createHash } from 'crypto';
import { Resolver } from 'dns/promises';

import { field, tag, type OsintProbeAdapter, type OsintScore, type OsintTag } from './shared';
import { DISPOSABLE_DOMAINS } from './disposable';

/**
 * Analyse d'une adresse e-mail.
 *
 * Volontairement **sans vérification SMTP** : ouvrir une connexion au serveur de
 * la cible pour lui demander si la boîte existe (`RCPT TO`) est détectable, se
 * fait bloquer, et prévient l'intéressé qu'on le cherche. On s'en tient à ce qui
 * se déduit du domaine et de sources publiques.
 */

function resolver(): Resolver {
    const r = new Resolver({ timeout: 4000, tries: 2 });
    r.setServers(['1.1.1.1', '8.8.8.8']);
    return r;
}

/**
 * Gravatar indexe par MD5 de l'adresse en minuscules : un `404` sur l'avatar dit
 * « aucun profil », un `200` dit « adresse utilisée quelque part ».
 */
function gravatarHash(email: string): string {
    return createHash('md5').update(email.trim().toLowerCase()).digest('hex');
}

async function hasGravatar(hash: string): Promise<boolean> {
    try {
        const res = await fetch(`https://www.gravatar.com/avatar/${hash}?d=404&s=80`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(4000)
        });
        return res.ok;
    } catch {
        return false;
    }
}

function scoreOf(signals: { label: string; delta: number }[]): OsintScore {
    let value = 50;
    for (const s of signals) value += s.delta;
    value = Math.max(0, Math.min(100, value));
    const label = value >= 75 ? 'Plausible' : value >= 45 ? 'Douteuse' : 'Peu crédible';
    const tone = value >= 75 ? 'good' : value >= 45 ? 'warn' : 'bad';
    return { value, label, tone, signals };
}

export const emailProbe: OsintProbeAdapter = {
    id: 'email',
    appliesTo: ['email'],
    ttlMs: 30 * 60 * 1000,
    async run({ target }) {
        const email = target.value;
        const at = email.lastIndexOf('@');
        const local = email.slice(0, at);
        const domain = email.slice(at + 1);
        const r = resolver();

        const [mx, txt, dmarcTxt, gravatar] = await Promise.all([
            r.resolveMx(domain).catch(() => []),
            r.resolveTxt(domain).catch(() => []),
            r.resolveTxt(`_dmarc.${domain}`).catch(() => []),
            hasGravatar(gravatarHash(email))
        ]);

        const spf = txt.map((p) => p.join('')).find((t) => t.toLowerCase().startsWith('v=spf1')) ?? null;
        const dmarc = dmarcTxt.map((p) => p.join('')).find((t) => t.toLowerCase().startsWith('v=dmarc1')) ?? null;
        const disposable = DISPOSABLE_DOMAINS.has(domain);

        const fields = [field('Partie locale', local, { mono: true }), field('Domaine', domain, { mono: true })];

        if (mx.length) {
            const sorted = [...mx].sort((a, b) => a.priority - b.priority);
            fields.push(
                field('Serveurs de courrier', sorted.map((m) => `${m.priority} ${m.exchange}`).join('\n'), {
                    mono: true
                })
            );
            // Le MX trahit l'hébergeur du courrier, ce qui oriente la suite.
            const host = sorted[0].exchange.toLowerCase();
            const provider = /google|gmail/.test(host)
                ? 'Google Workspace'
                : /outlook|microsoft|protection\.outlook/.test(host)
                  ? 'Microsoft 365'
                  : /proton/.test(host)
                    ? 'Proton Mail'
                    : /zoho/.test(host)
                      ? 'Zoho'
                      : /ovh/.test(host)
                        ? 'OVH'
                        : null;
            if (provider) fields.push(field('Hébergeur du courrier', provider));
        }

        if (spf) fields.push(field('SPF', spf, { mono: true }));
        if (dmarc) fields.push(field('DMARC', dmarc, { mono: true }));
        fields.push(field('Domaine jetable', disposable ? 'Oui' : 'Non répertorié'));
        fields.push(field('Profil Gravatar', gravatar ? 'Existe' : 'Aucun'));

        const signals: { label: string; delta: number }[] = [];
        if (mx.length) signals.push({ label: 'Le domaine accepte du courrier (MX)', delta: +30 });
        else signals.push({ label: 'Aucun MX — le domaine ne reçoit pas de courrier', delta: -45 });
        if (disposable) signals.push({ label: 'Domaine de messagerie jetable', delta: -40 });
        if (gravatar) signals.push({ label: 'Adresse rattachée à un profil Gravatar public', delta: +20 });
        if (spf) signals.push({ label: 'SPF publié', delta: +5 });
        if (dmarc) signals.push({ label: 'DMARC publié', delta: +5 });

        const tags: OsintTag[] = [];
        if (disposable) tags.push(tag('Jetable', 'bad'));
        if (mx.length) tags.push(tag('Reçoit du courrier', 'good'));
        else tags.push(tag('Aucun MX', 'bad'));
        if (gravatar) tags.push(tag('Gravatar', 'good'));
        if (!spf && mx.length) tags.push(tag('Sans SPF', 'warn'));

        const links = [
            {
                label: 'Fuites connues (HIBP)',
                href: `https://haveibeenpwned.com/unifiedsearch/${encodeURIComponent(email)}`
            },
            { label: 'Domaine', href: `osint:domain/${domain}` }
        ];
        if (gravatar) links.push({ label: 'Profil Gravatar', href: `https://gravatar.com/${gravatarHash(email)}` });

        return {
            summary: disposable
                ? 'Adresse sur un domaine jetable.'
                : mx.length
                  ? `Domaine actif, ${mx.length} serveur(s) de courrier.`
                  : 'Le domaine ne reçoit pas de courrier.',
            fields,
            tags,
            links,
            score: scoreOf(signals)
        };
    }
};
