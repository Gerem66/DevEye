import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { DAY, dayOf, destinationOf, isExpired, now } from './_shared';
import { linkRow, memoryRepo } from './_testing';
import { createChecker, type CheckVerdict } from './checker';
import { Counters, primaryLanguage } from './counters';
import { serverEntry } from './index';
import { bucketSeries, rangeWindow } from './stats';

/**
 * Ce qui tourne sans membre : les compteurs et leurs avis de limite, le
 * contrôle des destinations et ses avis groupés, et les règles pures qui
 * décident d'une destination, d'une expiration et d'un graphique.
 */

const CHROME = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

const visit = (ip: string, over: Partial<Parameters<Counters['record']>[0]> = {}) => ({
    linkId: 1,
    workspaceId: 1,
    ip,
    userAgent: CHROME,
    referrer: 'https://www.google.com/search?q=x',
    acceptLanguage: 'fr-FR,fr;q=0.9,en;q=0.8',
    ownHosts: ['public.deveye.test'],
    ...over
});

describe('les compteurs', () => {
    it('comptent chaque personne une fois par jour, rangent sa provenance, et tiennent l’usage du mois', async () => {
        const repo = memoryRepo([linkRow({ id: 1 })]);
        const deps = createTestServiceDeps({ repo, quotas: serverEntry.quotas });
        const counters = new Counters(deps);
        counters.record(visit('203.0.113.7'), 'FR');
        counters.record(visit('203.0.113.7'), 'FR');
        counters.record(visit('198.51.100.4', { referrer: undefined }), null);
        assert.equal(counters.pendingLinkVisits(1), 2);
        await counters.flush();
        assert.equal(counters.pendingLinkVisits(1), 0);
        const [day] = [...repo.daily.values()];
        assert.equal(day.clicks, 3);
        assert.equal(day.visits, 2);
        assert.equal(repo.rows[0].visits_total, 2);
        const dims = [...repo.dims.values()];
        const of = (kind: string) => dims.filter((d) => d.kind === kind).map((d) => [d.value, d.visits]);
        assert.deepEqual(of('country').sort(), [
            ['', 1],
            ['FR', 1]
        ]);
        assert.deepEqual(of('language'), [['fr', 2]]);
        // Le site d'origine passe par son étiquette chiffrée : la table n'en garde que l'identifiant.
        assert.equal(repo.labelRows.length, 1);
        assert.equal(repo.labelRows[0].content, 'www.google.com');
        assert.deepEqual(of('referrer').sort(), [
            ['', 1],
            ['1', 1]
        ]);
        // Une personne déjà comptée, même après un redémarrage, ne l'est pas deux fois.
        const restarted = new Counters(deps);
        restarted.record(visit('203.0.113.7'), 'FR');
        await restarted.flush();
        assert.equal([...repo.daily.values()][0].visits, 2);
    });

    it('préviennent à 80 % puis à la limite, une fois chacun, et ferment le mois à la limite', async () => {
        const repo = memoryRepo([linkRow({ id: 1 })]);
        const deps = createTestServiceDeps({ repo, quotas: serverEntry.quotas, quotaLimits: { visits: 5 } });
        const counters = new Counters(deps);
        for (let i = 1; i <= 4; i++) counters.record(visit(`203.0.113.${i}`), null);
        await counters.flush();
        assert.equal(deps.recorded.notifications.length, 1);
        assert.match(deps.recorded.notifications[0].subject, /80 %/);
        assert.equal(await counters.allows(1), true);
        counters.record(visit('203.0.113.9'), null);
        await counters.flush();
        assert.equal(deps.recorded.notifications.length, 2);
        assert.match(deps.recorded.notifications[1].subject, /limite/);
        counters.record(visit('203.0.113.10'), null);
        await counters.flush();
        assert.equal(deps.recorded.notifications.length, 2);
    });

    it('lisent la langue principale du navigateur', () => {
        assert.equal(primaryLanguage('fr-FR,fr;q=0.9'), 'fr');
        assert.equal(primaryLanguage('EN'), 'en');
        assert.equal(primaryLanguage('*'), '');
        assert.equal(primaryLanguage(undefined), '');
    });
});

describe('le contrôle des destinations', () => {
    it('revérifie un premier échec avant de prévenir, groupe l’avis par destination, et dit le retour', async () => {
        const repo = memoryRepo([
            linkRow({ id: 1, code: 'abcdef', check_state: 'ok' }),
            linkRow({ id: 2, code: 'bcdefg', check_state: 'ok' })
        ]);
        const deps = createTestServiceDeps({ repo });
        let verdict: CheckVerdict = { ok: false, error: 'code 404' };
        const checker = createChecker(deps, { probe: async () => verdict });
        const [tick] = (checker.service(), deps.recorded.tickers);

        await tick.tick();
        assert.equal(deps.recorded.notifications.length, 0);
        assert.equal(repo.rows[0].check_state, 'ok');
        assert.ok((repo.rows[0].check_due ?? 0) < now() + DAY);

        for (const row of repo.rows) row.check_due = 0;
        await tick.tick();
        assert.equal(repo.rows[0].check_state, 'broken');
        assert.equal(repo.rows[0].check_error, 'code 404');
        assert.equal(deps.recorded.notifications.length, 1);
        assert.deepEqual(deps.recorded.notifications[0].itemIds, [1, 2]);

        verdict = { ok: true };
        for (const row of repo.rows) row.check_due = 0;
        await tick.tick();
        assert.equal(repo.rows[0].check_state, 'ok');
        assert.equal(deps.recorded.notifications.length, 2);
        assert.match(deps.recorded.notifications[1].subject, /rétablie/);
    });

    it('passe son tour pour un lien que l’offre tient en pause', async () => {
        const repo = memoryRepo([linkRow({ id: 1 })]);
        const deps = createTestServiceDeps({ repo, pausedItems: { links: ['1'] } });
        let probes = 0;
        const checker = createChecker(deps, {
            probe: async () => {
                probes++;
                return { ok: true };
            }
        });
        checker.service();
        await deps.recorded.tickers[0].tick();
        assert.equal(probes, 0);
        assert.ok((repo.rows[0].check_due ?? 0) > now());
    });
});

describe('les règles pures', () => {
    it('choisissent la destination de l’appareil et ajoutent la campagne', () => {
        const targets = {
            default: 'https://exemple.fr/?utm_source=ancien',
            ios: 'https://apps.apple.com/1',
            android: null
        };
        const utm = { source: 'affiche', medium: '', campaign: 'ete', term: '', content: '' };
        assert.equal(destinationOf(targets, utm, 'other'), 'https://exemple.fr/?utm_source=affiche&utm_campaign=ete');
        assert.equal(destinationOf(targets, utm, 'android'), 'https://exemple.fr/?utm_source=affiche&utm_campaign=ete');
        assert.equal(
            destinationOf(targets, utm, 'ios'),
            'https://apps.apple.com/1?utm_source=affiche&utm_campaign=ete'
        );
        assert.equal(destinationOf({ ...targets, default: 'javascript:alert(1)' }, utm, 'other'), null);
    });

    it('disent un lien expiré par sa date ou ses visites, en attente comprises', () => {
        const at = 1_000;
        assert.equal(isExpired({ expires_at: 1_000, max_visits: null, visits_total: 0 }, at), true);
        assert.equal(isExpired({ expires_at: 1_001, max_visits: null, visits_total: 0 }, at), false);
        assert.equal(isExpired({ expires_at: null, max_visits: 3, visits_total: 2 }, at), false);
        assert.equal(isExpired({ expires_at: null, max_visits: 3, visits_total: 2 }, at, 1), true);
    });

    it('découpent une période en jours, ou en semaines sur douze mois, jours vides compris', () => {
        const today = dayOf(now());
        const week = rangeWindow('7d', today);
        const series = bucketSeries([{ day: today, clicks: 3, visits: 2 }], week);
        assert.equal(series.length, 7);
        assert.deepEqual(series[6], { at: today * DAY, clicks: 3, visits: 2 });
        const year = rangeWindow('12m', today);
        const weeks = bucketSeries([{ day: today, clicks: 1, visits: 1 }], year);
        assert.equal(weeks.length, 52);
        assert.equal(weeks[51].visits, 1);
    });
});
