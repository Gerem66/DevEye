import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer, SdkCipher } from '@deveye/types/sdk/server';

import { monthOf, now, openContent, setRuntime, SHORT_HOST } from './_shared';
import { env, SHORTLINKS_ENV } from './env';
import { shortlinksAccountExport } from './accountExport';
import { createChecker } from './checker';
import { Counters } from './counters';
import { createDomainHooks } from './domains';
import { shortlinksE2e } from './e2e';
import { linkHandlers } from './handlers';
import { shortlinksMailSamples } from './mails';
import { moderationHandlers } from './moderation';
import { createRedirector } from './redirect';
import { createRepo, type ShortlinksRepo } from './repo';
import { reportContext } from './reports';

/** Les provenances détaillées se gardent un peu plus d'un an : de quoi comparer douze mois au précédent. */
const DIMS_DAYS = 400;
/** Un signalement clos reste un an, trace de la décision. */
const REPORT_RETENTION_SECONDS = 365 * 86_400;

async function labelOf(repo: ShortlinksRepo, cipher: SdkCipher, itemId: string, workspaceId: number) {
    const row = await repo.links.findVisible(Number(itemId), workspaceId);
    if (!row) return null;
    const content = await openContent(cipher, row.content);
    if (content.title) return content.title;
    try {
        return new URL(content.targets.default).host;
    } catch {
        return row.code;
    }
}

/**
 * `items` : ce que le partage et les routes de notification savent des liens
 * sans ouvrir la fonctionnalité. Les tables ont le préfixe `ft_shortlinks_` et
 * leurs migrations ici.
 */
export const serverEntry: FeatureServer<ShortlinksRepo> = {
    env: SHORTLINKS_ENV,
    createRepo,
    features: [...linkHandlers, ...moderationHandlers],
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    domains: createDomainHooks(),
    quotas: {
        links: { list: (repo, owned) => repo.links.listStock(owned) },
        visits: { count: (repo, owned) => repo.counters.monthlyVisits(owned, monthOf(now())) }
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.links.findVisible(Number(itemId), workspaceId))?.workspace_id ?? null,
        labelOf
    },
    accountExport: shortlinksAccountExport,
    sealed: [
        { table: 'ft_shortlinks_reports', column: 'content', id: 'ref', context: (ref) => reportContext(String(ref)) }
    ],
    mailSamples: shortlinksMailSamples(),
    e2e: shortlinksE2e,
    createService(deps) {
        if (env.SHORTLINKS_LISTEN_PORT > 0 && SHORT_HOST === null) {
            throw new Error(
                'SHORTLINKS_LISTEN_PORT exige SHORTLINKS_ORIGIN : l’écouteur des liens ne sert que le domaine court.'
            );
        }
        const counters = new Counters(deps);
        const redirector = createRedirector(deps, counters);
        const checker = createChecker(deps);
        const flusher = counters.service();
        const checks = checker.service();
        const upkeep = deps.createTicker({
            intervalMs: 3_600_000,
            tick: async () => {
                await counters.prune(DIMS_DAYS);
                await deps.repo.reports.purge(now() - REPORT_RETENTION_SECONDS);
            }
        });
        const services = [flusher, checks, upkeep];
        return {
            start() {
                setRuntime({
                    forget: (id) => redirector.forget(id),
                    checkNow: (row) => checker.checkNow(row),
                    pendingLinkVisits: (id) => counters.pendingLinkVisits(id),
                    deps
                });
                for (const service of services) void service.start();
            },
            async stop() {
                await Promise.all(services.map((service) => service.stop()));
                // Ce qui restait en mémoire part avant l'arrêt : une visite comptée ne se perd pas.
                await counters.flush();
                setRuntime(null);
            },
            ownHosts: SHORT_HOST === null ? [] : [SHORT_HOST],
            ...(env.SHORTLINKS_LISTEN_PORT > 0 ? { ownListener: { port: env.SHORTLINKS_LISTEN_PORT } } : {}),
            publicRoutes: (app) => redirector.routes(app),
            hostRequest: (req, reply, domain) => redirector.hostRequest(req, reply, domain)
        };
    }
};
