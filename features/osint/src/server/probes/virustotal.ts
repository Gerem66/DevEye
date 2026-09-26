// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { safeFetch } from '@/Services/netFetch';
import { field, formatDate, skipped, tag, type OsintField, type OsintProbeAdapter, type OsintTag } from './shared';

/**
 * Le verdict de VirusTotal sur un domaine ou une IP : combien de moteurs le
 * signalent, et lesquels. Lecture seule des analyses existantes, rien n'est
 * soumis.
 */

interface VtAttributes {
    last_analysis_stats?: { malicious?: number; suspicious?: number; harmless?: number; undetected?: number };
    last_analysis_results?: Record<string, { category?: string; result?: string }>;
    last_analysis_date?: number;
    reputation?: number;
    categories?: Record<string, string>;
    registrar?: string;
    creation_date?: number;
    as_owner?: string;
    country?: string;
    tags?: string[];
}

export const virustotalProbe: OsintProbeAdapter = {
    id: 'virustotal',
    appliesTo: ['domain', 'url', 'ip'],
    ttlMs: 6 * 60 * 60 * 1000,
    async run({ target, key }) {
        const isIp = target.kind === 'ip';
        const gui = `https://www.virustotal.com/gui/${isIp ? 'ip-address' : 'domain'}/${encodeURIComponent(target.value)}`;
        if (!key) {
            return skipped('Aucune clé VirusTotal enregistrée. La fiche reste consultable à la main.', [
                { label: 'Fiche VirusTotal', href: gui },
                { label: 'Obtenir une clé VirusTotal', href: 'https://www.virustotal.com/gui/join-us' }
            ]);
        }

        const res = await safeFetch(
            `https://www.virustotal.com/api/v3/${isIp ? 'ip_addresses' : 'domains'}/${encodeURIComponent(target.value)}`,
            { signal: AbortSignal.timeout(6000), headers: { 'x-apikey': key, accept: 'application/json' } }
        );
        if (res.status === 404) {
            return {
                status: 'empty',
                summary: 'Inconnu de VirusTotal.',
                links: [{ label: 'Fiche VirusTotal', href: gui }]
            };
        }
        if (res.status === 401) throw new Error('Clé VirusTotal refusée : vérifiez-la dans les réglages.');
        if (res.status === 429) throw new Error('Quota VirusTotal atteint (4 requêtes par minute en offre gratuite).');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const a = ((await res.json()) as { data?: { attributes?: VtAttributes } }).data?.attributes ?? {};
        const s = a.last_analysis_stats ?? {};
        const malicious = s.malicious ?? 0;
        const suspicious = s.suspicious ?? 0;
        const total = malicious + suspicious + (s.harmless ?? 0) + (s.undetected ?? 0);
        const flaggedBy = Object.entries(a.last_analysis_results ?? {})
            .filter(([, r]) => r.category === 'malicious' || r.category === 'suspicious')
            .map(([engine, r]) => `${engine} : ${r.result ?? r.category}`);

        const fields: OsintField[] = [
            field('Verdict', `${malicious} malveillant(s), ${suspicious} suspect(s) sur ${total} moteur(s)`)
        ];
        if (flaggedBy.length) fields.push(field('Signalé par', flaggedBy.slice(0, 12).join('\n')));
        if (a.reputation != null) fields.push(field('Réputation communautaire', String(a.reputation)));
        const categories = [...new Set(Object.values(a.categories ?? {}))];
        if (categories.length) fields.push(field('Catégories', categories.slice(0, 6).join(', ')));
        if (a.as_owner) fields.push(field('Réseau', a.as_owner));
        if (a.country) fields.push(field('Pays', a.country));
        if (a.registrar) fields.push(field('Registrar', a.registrar));
        if (a.creation_date) {
            fields.push(field('Création', formatDate(new Date(a.creation_date * 1000).toISOString()) ?? '?'));
        }
        if (a.last_analysis_date) {
            fields.push(
                field('Dernière analyse', formatDate(new Date(a.last_analysis_date * 1000).toISOString()) ?? '?')
            );
        }

        const tags: OsintTag[] = [];
        if (malicious > 0) tags.push(tag(`${malicious} moteur(s) : malveillant`, 'bad'));
        else if (suspicious > 0) tags.push(tag(`${suspicious} moteur(s) : suspect`, 'warn'));
        else tags.push(tag('Aucun signalement', 'good'));
        for (const t of (a.tags ?? []).slice(0, 3)) tags.push(tag(t, 'neutral'));

        return {
            summary:
                malicious + suspicious > 0
                    ? `Signalé par ${malicious + suspicious} moteur(s) sur ${total}.`
                    : `Aucun des ${total} moteurs ne le signale.`,
            fields,
            tags,
            links: [{ label: 'Fiche VirusTotal', href: gui }]
        };
    }
};
