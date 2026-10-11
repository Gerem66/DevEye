import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkDomain, SdkPublicApp, SdkPublicReply, SdkPublicRequest } from '@deveye/types/sdk/server';
import { createTestServiceDeps, testDomain } from '@deveye/types/sdk/testing';

import { hashPassword } from './_shared';
import { linkRow, memoryRepo, type MemoryRepo } from './_testing';
import { Counters } from './counters';
import { serverEntry } from './index';
import { createRedirector } from './redirect';
import type { LinkRow } from './repo';

/**
 * La redirection telle qu'un visiteur la vit : le bon verdict pour chaque état
 * du lien, la destination de son appareil et de la campagne, le mot de passe,
 * l'aperçu, le signalement, et un lien qui ne paraît jamais sous le domaine
 * d'un autre espace.
 */

interface Answer {
    status: number;
    headers: Record<string, string>;
    body: string;
}

function reply(): SdkPublicReply & { answer: Answer } {
    const answer: Answer = { status: 200, headers: {}, body: '' };
    const self: SdkPublicReply & { answer: Answer } = {
        answer,
        header(name, value) {
            answer.headers[name.toLowerCase()] = String(value);
            return self;
        },
        code(status) {
            answer.status = status;
            return self;
        },
        send(payload) {
            answer.body = typeof payload === 'string' ? payload : '';
            return answer;
        }
    };
    return self;
}

const CHROME = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';

function content(over: Record<string, unknown> = {}) {
    return JSON.stringify({
        title: 'Rentrée',
        targets: { default: 'https://exemple.fr/offre?ref=1', ios: 'https://apps.apple.com/app/1', android: null },
        utm: { source: 'affiche', medium: '', campaign: '', term: '', content: '' },
        ...over
    });
}

function mount(
    rows: LinkRow[],
    opts: { domains?: readonly SdkDomain[]; paused?: string[]; visitsLimit?: number } = {}
) {
    const repo: MemoryRepo = memoryRepo(rows);
    const deps = createTestServiceDeps({
        repo,
        domains: opts.domains ?? [],
        pausedItems: { links: opts.paused ?? [] },
        quotas: serverEntry.quotas,
        quotaLimits: opts.visitsLimit === undefined ? {} : { visits: opts.visitsLimit },
        countries: { '203.0.113.7': 'FR' }
    });
    const counters = new Counters(deps);
    const redirector = createRedirector(deps, counters);
    const gets = new Map<string, (req: SdkPublicRequest, res: SdkPublicReply) => Promise<unknown>>();
    const posts = new Map<string, (req: SdkPublicRequest, res: SdkPublicReply) => Promise<unknown>>();
    const app: SdkPublicApp = {
        get: (path, _opts, handler) => gets.set(path, handler),
        post: (path, _opts, handler) => posts.set(path, handler),
        postStream: () => undefined
    };
    redirector.routes(app);
    const request = (over: Partial<SdkPublicRequest>): SdkPublicRequest => ({
        headers: { 'user-agent': CHROME },
        host: 'public.deveye.test',
        body: undefined,
        ip: '203.0.113.7',
        method: 'GET',
        ...over
    });
    const get = async (code: string, over: Partial<SdkPublicRequest> = {}) => {
        const res = reply();
        await gets.get('/l/:code')!(request({ params: { code }, ...over }), res);
        return res.answer;
    };
    const post = async (path: string, code: string, body: unknown, over: Partial<SdkPublicRequest> = {}) => {
        const res = reply();
        await posts.get(path)!(request({ params: { code }, body, method: 'POST', ...over }), res);
        return res.answer;
    };
    const onHost = async (path: string, domain: SdkDomain | null, over: Partial<SdkPublicRequest> = {}) => {
        const res = reply();
        await redirector.hostRequest(
            { ...request(over), method: over.method === 'HEAD' ? 'HEAD' : 'GET', path },
            res,
            domain
        );
        return res.answer;
    };
    const reportForm = async (code: string) => {
        const res = reply();
        await gets.get('/l/:code/signaler')!(request({ params: { code } }), res);
        return res.answer;
    };
    return { repo, deps, counters, redirector, get, post, onHost, reportForm };
}

describe('la redirection', () => {
    it('redirige en 302 vers la destination, campagne comprise, sans cache', async () => {
        const m = mount([linkRow({ id: 1, code: 'abcdef', content: content() })]);
        const res = await m.get('abcdef');
        assert.equal(res.status, 302);
        assert.equal(res.headers.location, 'https://exemple.fr/offre?ref=1&utm_source=affiche');
        assert.match(res.headers['cache-control'] ?? '', /no-store/);
    });

    it('choisit la destination de l’appareil', async () => {
        const m = mount([linkRow({ id: 1, code: 'abcdef', content: content() })]);
        const res = await m.get('abcdef', { headers: { 'user-agent': IPHONE } });
        assert.equal(res.headers.location, 'https://apps.apple.com/app/1?utm_source=affiche');
    });

    it('répond « introuvable » pareil pour un code inconnu, mal formé, coupé ou tenu en pause par l’offre', async () => {
        const m = mount([linkRow({ id: 1, code: 'abcdef', enabled: 0 }), linkRow({ id: 2, code: 'bcdefg' })], {
            paused: ['2']
        });
        const answers = [await m.get('zzzzzz'), await m.get('../adm'), await m.get('abcdef'), await m.get('bcdefg')];
        for (const res of answers) assert.equal(res.status, 404);
        assert.equal(answers[0].body, answers[3].body);
    });

    it('dit qu’un lien est retiré, expiré, ou momentanément indisponible', async () => {
        const past = Math.floor(Date.now() / 1000) - 10;
        const m = mount(
            [
                linkRow({ id: 1, code: 'abcdef', blocked_at: 1, blocked_reason: 'Hameçonnage' }),
                linkRow({ id: 2, code: 'bcdefg', expires_at: past }),
                linkRow({ id: 3, code: 'cdefgh', max_visits: 5, visits_total: 5 })
            ],
            {}
        );
        assert.equal((await m.get('abcdef')).status, 410);
        assert.equal((await m.get('bcdefg')).status, 410);
        assert.equal((await m.get('cdefgh')).status, 410);
        const full = mount([linkRow({ id: 1, code: 'abcdef' })], { visitsLimit: 0 });
        const res = await full.get('abcdef');
        assert.equal(res.status, 503);
        assert.ok(!res.body.includes('offre'));
    });

    it('relit le lien après une écriture, pas avant', async () => {
        const m = mount([linkRow({ id: 1, code: 'abcdef' })]);
        assert.equal((await m.get('abcdef')).status, 302);
        m.repo.rows[0] = { ...m.repo.rows[0], enabled: 0 };
        assert.equal((await m.get('abcdef')).status, 302);
        m.redirector.forget(1);
        assert.equal((await m.get('abcdef')).status, 404);
    });

    it('ne redirige ni sous l’app ni sous un nom de DevEye qui ne sert pas les liens', async () => {
        const m = mount([linkRow({ id: 1, code: 'abcdef' })]);
        assert.equal((await m.get('abcdef', { host: 'deveye.test' })).status, 404);
        assert.equal((await m.get('abcdef+', { host: 'deveye.test' })).status, 404);
        assert.equal((await m.post('/l/:code/deverrouiller', 'abcdef', {}, { host: 'deveye.test' })).status, 404);
        assert.equal((await m.reportForm('abcdef')).status, 200);
    });

    it('ne paraît pas sous le domaine d’un autre espace', async () => {
        const domains = [
            testDomain({ id: 5, host: 'go.exemple.fr', workspaceId: 1 }),
            testDomain({ id: 6, host: 'go.autre.fr', workspaceId: 42 })
        ];
        const m = mount([linkRow({ id: 1, code: 'abcdef' })], { domains });
        assert.equal((await m.get('abcdef', { host: 'go.exemple.fr' })).status, 302);
        assert.equal((await m.get('abcdef', { host: 'go.autre.fr' })).status, 404);
    });
});

describe('le mot de passe et l’aperçu', () => {
    it('demande le mot de passe, refuse le mauvais, redirige avec le bon', async () => {
        const m = mount([linkRow({ id: 1, code: 'abcdef', password_hash: await hashPassword('secret-1') })]);
        const asked = await m.get('abcdef');
        assert.equal(asked.status, 401);
        assert.ok(asked.body.includes('/l/abcdef/deverrouiller'));
        assert.ok(!asked.body.includes('exemple.fr/page'));
        const wrong = await m.post('/l/:code/deverrouiller', 'abcdef', { password: 'faux' });
        assert.equal(wrong.status, 403);
        const right = await m.post('/l/:code/deverrouiller', 'abcdef', { password: 'secret-1' });
        assert.equal(right.status, 303);
        assert.equal(right.headers.location, 'https://exemple.fr/page');
    });

    it('montre la destination dans l’aperçu, sauf derrière un mot de passe', async () => {
        const m = mount([
            linkRow({ id: 1, code: 'abcdef', content: content() }),
            linkRow({ id: 2, code: 'bcdefg', password_hash: 'scrypt$x$y' })
        ]);
        const open = await m.get('abcdef+');
        assert.equal(open.status, 200);
        assert.ok(open.body.includes('https://exemple.fr/offre?ref=1&amp;utm_source=affiche'));
        assert.ok(open.body.includes('/l/abcdef/signaler'));
        const guarded = await m.get('bcdefg+');
        assert.equal(guarded.status, 200);
        assert.ok(!guarded.body.includes('exemple.fr/page'));
    });
});

describe('les noms servis en entier', () => {
    const domain = testDomain({ id: 5, host: 'go.exemple.fr', workspaceId: 1 });

    it('sert un alias et la racine d’un domaine de l’espace', async () => {
        const m = mount([
            linkRow({ id: 1, code: 'abcdef', domain_id: 5, slug: 'promo' }),
            linkRow({ id: 2, code: 'bcdefg', domain_id: 5, slug: '' })
        ]);
        assert.equal((await m.onHost('/Promo', domain)).status, 302);
        assert.equal((await m.onHost('/', domain)).status, 302);
        assert.equal((await m.onHost('/autre', domain)).status, 404);
        assert.equal((await m.onHost('/promo/plus', domain)).status, 404);
        assert.equal((await m.onHost('/%E0%A4%A', domain)).status, 404);
    });

    it('ne sert pas l’alias d’un autre espace sous ce domaine', async () => {
        const m = mount([linkRow({ id: 1, code: 'abcdef', workspace_id: 9, domain_id: 5, slug: 'promo' })]);
        assert.equal((await m.onHost('/promo', domain)).status, 404);
    });

    it('sert les codes à la racine du domaine court, et le site vitrine à `/`', async () => {
        const m = mount([linkRow({ id: 1, code: 'abcdef' })]);
        assert.equal((await m.onHost('/abcdef', null)).status, 302);
        assert.equal((await m.onHost('/abcdef+', null)).status, 200);
        const root = await m.onHost('/', null);
        assert.equal(root.status, 302);
        assert.equal(root.headers.location, 'https://site.deveye.test');
    });
});

describe('le comptage', () => {
    it('compte une ouverture par passage, une visite par personne, et les robots à part', async () => {
        const m = mount([linkRow({ id: 1, code: 'abcdef' })]);
        await m.get('abcdef');
        await m.get('abcdef');
        await m.get('abcdef', { headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0' } });
        await m.onHost('/abcdef', null, { method: 'HEAD' });
        await m.counters.flush();
        const [day] = [...m.repo.daily.values()];
        assert.deepEqual({ clicks: day.clicks, visits: day.visits, bots: day.bots }, { clicks: 2, visits: 1, bots: 1 });
        assert.equal(m.repo.rows[0].visits_total, 1);
        const country = [...m.repo.dims.values()].find((row) => row.kind === 'country');
        assert.equal(country?.value, 'FR');
    });
});

describe('le signalement', () => {
    it('enregistre un signalement complet, et ignore un robot qui remplit le piège', async () => {
        const m = mount([linkRow({ id: 1, code: 'abcdef', content: content() })]);
        assert.equal((await m.reportForm('abcdef')).status, 200);
        const body = {
            reason: 'phishing',
            message: 'Cette page imite ma banque.',
            name: 'Camille',
            email: 'camille@exemple.fr',
            goodFaith: 'on'
        };
        const trapped = await m.post('/l/:code/signaler', 'abcdef', { ...body, _hp: 'x' });
        assert.equal(trapped.status, 404);
        const incomplete = await m.post('/l/:code/signaler', 'abcdef', { ...body, email: 'pas-une-adresse' });
        assert.equal(incomplete.status, 400);
        const done = await m.post('/l/:code/signaler', 'abcdef', body);
        assert.equal(done.status, 200);
        assert.equal(m.repo.reportRows.length, 1);
        assert.equal(m.repo.reportRows[0].reason, 'phishing');
        assert.ok(!m.repo.reportRows[0].content.includes('camille@exemple.fr'));
    });
});
