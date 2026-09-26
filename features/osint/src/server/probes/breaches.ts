// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { safeFetch } from '@/Services/netFetch';
import { field, formatDate, skipped, tag, type OsintProbeAdapter } from './shared';

/**
 * Les fuites de données connues pour une adresse, par Have I Been Pwned. Le
 * nom de la fuite et les catégories exposées, jamais leur contenu : HIBP ne
 * sert aucun mot de passe, et ce module n'en ira chercher nulle part.
 */

interface HibpBreach {
    Name: string;
    Title?: string;
    Domain?: string;
    BreachDate?: string;
    PwnCount?: number;
    DataClasses?: string[];
    IsVerified?: boolean;
    IsSensitive?: boolean;
}

const SHOWN = 12;

export const breachesProbe: OsintProbeAdapter = {
    id: 'breaches',
    appliesTo: ['email'],
    ttlMs: 12 * 60 * 60 * 1000,
    async run({ target, key }) {
        const manual = {
            label: 'Vérifier sur haveibeenpwned.com',
            href: `https://haveibeenpwned.com/unifiedsearch/${encodeURIComponent(target.value)}`
        };
        if (!key) {
            return skipped('Aucune clé Have I Been Pwned enregistrée. La vérification reste possible à la main.', [
                manual,
                { label: 'Obtenir une clé HIBP', href: 'https://haveibeenpwned.com/API/Key' }
            ]);
        }

        const res = await safeFetch(
            `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(target.value)}?truncateResponse=false`,
            {
                signal: AbortSignal.timeout(6000),
                headers: { 'hibp-api-key': key, 'user-agent': 'DevEye-OSINT', accept: 'application/json' }
            }
        );
        if (res.status === 404) {
            return {
                status: 'empty',
                summary: 'Adresse absente de toutes les fuites connues de HIBP.',
                tags: [tag('Aucune fuite', 'good')],
                links: [manual]
            };
        }
        if (res.status === 401) throw new Error('Clé HIBP refusée : vérifiez-la dans les réglages.');
        if (res.status === 429) throw new Error('HIBP limite les requêtes de cette clé, réessayez dans un instant.');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const breaches = ((await res.json()) as HibpBreach[]).sort((a, b) =>
            (b.BreachDate ?? '').localeCompare(a.BreachDate ?? '')
        );
        const exposed = [...new Set(breaches.flatMap((b) => b.DataClasses ?? []))];
        const withPasswords = breaches.filter((b) => b.DataClasses?.includes('Passwords')).length;

        const fields = breaches
            .slice(0, SHOWN)
            .map((b) =>
                field(
                    `${b.Title ?? b.Name}${b.Domain ? ` (${b.Domain})` : ''}`,
                    [formatDate(b.BreachDate) ?? '?', (b.DataClasses ?? []).join(', ')].join('\n')
                )
            );
        if (breaches.length > SHOWN) {
            fields.push(field('Autres', `${breaches.length - SHOWN} fuite(s) plus ancienne(s)`));
        }
        fields.push(field('Données exposées', exposed.join(', ')));

        return {
            summary: `Adresse présente dans ${breaches.length} fuite(s), la plus récente en ${breaches[0]?.BreachDate?.slice(0, 4) ?? '?'}.`,
            fields,
            tags: [
                tag(`${breaches.length} fuite(s)`, 'bad'),
                ...(withPasswords ? [tag(`Mots de passe dans ${withPasswords}`, 'bad')] : []),
                ...(breaches.some((b) => b.IsSensitive) ? [tag('Fuite sensible', 'warn')] : [])
            ],
            links: [manual]
        };
    }
};
