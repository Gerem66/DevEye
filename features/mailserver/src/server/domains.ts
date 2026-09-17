import { FeatureError, type FeatureDomainsEntry } from '@deveye/types/sdk/server';

import { dkimRecordName, dkimRecordValue, ensureDomainKey } from './dkim';
import { env } from './env';
import type { MailserverRepo } from './repo';

/**
 * La moitié « service » de la vérification d'un domaine. DevEye prouve la
 * propriété ; ce module dit quoi publier pour que le courrier arrive (MX) et
 * que celui qui part soit cru (SPF, DKIM, DMARC), puis vérifie les deux
 * enregistrements sans lesquels rien ne marche : le MX et la clé DKIM.
 */

const bare = (name: string): string => name.trim().toLowerCase().replace(/\.+$/, '');

/** Un TXT se compare sans ses espaces : les hébergeurs en ajoutent, ou recollent les morceaux avec. */
const squeeze = (value: string): string => value.replace(/\s+/g, '');

export function createDomainHooks(hostname = env.MAILSERVER_HOSTNAME): FeatureDomainsEntry<MailserverRepo> {
    return {
        async records(ctx, domain) {
            if (hostname === '') return [];
            const key = await ensureDomainKey(ctx.repo, ctx.keys, domain);
            return [
                { type: 'MX', name: domain.host, value: hostname, priority: 10 },
                // `mx` plutôt qu'une adresse : le serveur peut changer d'IP sans que chaque domaine retouche son SPF.
                { type: 'TXT', name: domain.host, value: 'v=spf1 mx -all' },
                { type: 'TXT', name: dkimRecordName(key), value: dkimRecordValue(key) },
                { type: 'TXT', name: `_dmarc.${domain.host}`, value: 'v=DMARC1; p=quarantine' }
            ];
        },

        async probe(ctx, domain) {
            if (hostname === '') {
                return { ok: false, error: 'Le serveur mail n’est pas configuré (MAILSERVER_HOSTNAME).' };
            }
            const exchanges = (await ctx.dns.mx(domain.host)).map((mx) => bare(mx.exchange));
            if (!exchanges.includes(hostname)) {
                return {
                    ok: false,
                    error:
                        exchanges.length === 0
                            ? 'Aucun enregistrement MX pour l’instant.'
                            : `Le MX vise ${exchanges.join(', ')}, pas ${hostname}.`
                };
            }
            const key = await ensureDomainKey(ctx.repo, ctx.keys, domain);
            const published = (await ctx.dns.txt(dkimRecordName(key))).map(squeeze);
            if (!published.some((value) => value.includes(`p=${key.public_key}`))) {
                return { ok: false, error: 'La clé DKIM publiée est absente ou ne correspond pas.' };
            }
            return { ok: true };
        },

        useCount: (ctx, workspaceId) => ctx.repo.countByDomain(workspaceId),

        async onRemoved(ctx, domain) {
            const held = (await ctx.repo.countByDomain(domain.workspaceId)).get(domain.id) ?? 0;
            if (held > 0) {
                throw new FeatureError(
                    'conflict',
                    `${held} adresse(s) vivent encore sur ce domaine : supprimez-les d’abord.`
                );
            }
        }
    };
}
