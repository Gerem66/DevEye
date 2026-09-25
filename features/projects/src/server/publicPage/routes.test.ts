import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkDomain, SdkPublicApp, SdkPublicReply, SdkPublicRequest } from '@deveye/types/sdk/server';
import { createTestServiceDeps, testDomain } from '@deveye/types/sdk/testing';

import type { ProjectCardRow, ProjectColumnRow, ProjectMilestoneRow, ProjectRow } from '../../contracts/domain';
import type { ProjectsRepo } from '../repo';
import { memoryPublicationRepo, type StoredPublication } from '../testing/publicationRepo';
import { createPublicPages } from './routes';
import { BOARD_SCRIPT_ETAG } from './script';

/**
 * Les routes publiques des tableaux : un projet ne se montre que sous l'adresse
 * de DevEye ou sous un domaine de son espace, un tableau retiré ne dit rien de
 * plus qu'un lien inconnu, la racine d'un domaine revient au plus ancien projet
 * en ligne, et rien de ce que les options taisent n'arrive dans le document.
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

const REF = '0123456789abcdef';
const OTHER_REF = 'fedcba9876543210';

function project(over: Partial<ProjectRow> & { id: number }): ProjectRow {
    return {
        workspace_id: 1,
        user_id: 1,
        status: 'active',
        security_tier: 'open',
        version_source: 'manual',
        show_overview: 0,
        show_timeline: 1,
        sort_order: over.id,
        start_date: null,
        due_date: null,
        archived_at: null,
        content: JSON.stringify({
            title: `Projet <${over.id}>`,
            icon: '',
            description: 'Refonte du site',
            tags: [],
            version: '2.1'
        }),
        created: 1,
        updated: 1,
        ...over
    };
}

function publication(over: Partial<StoredPublication> & { project_id: number }): StoredPublication {
    return {
        public_ref: REF,
        enabled: 1,
        published_at: 1,
        domain_id: null,
        slug: null,
        domain_at: null,
        show_dates: 0,
        show_assignees: 0,
        show_subtasks: 0,
        theme: 'auto',
        accent: '',
        created: 1,
        ...over
    };
}

const COLUMNS: ProjectColumnRow[] = [
    {
        id: 10,
        project_id: 1,
        workspace_id: 1,
        sort_order: 0,
        counts_as_done: 0,
        wip_limit: null,
        content: JSON.stringify({ name: 'À faire' }),
        created: 1
    },
    {
        id: 11,
        project_id: 1,
        workspace_id: 1,
        sort_order: 1,
        counts_as_done: 1,
        wip_limit: null,
        content: JSON.stringify({ name: 'Terminé' }),
        created: 1
    }
];

function card(over: Partial<ProjectCardRow> & { id: number; column_id: number }): ProjectCardRow {
    return {
        project_id: 1,
        workspace_id: 1,
        sort_order: over.id,
        author_user_id: 1,
        assignee_user_id: 7,
        priority: 3,
        start_date: null,
        due_date: 1_000,
        estimate_minutes: null,
        required_open_count: 0,
        milestone_id: 50,
        archived_at: null,
        message_count: 4,
        last_message_at: null,
        content: JSON.stringify({
            title: `Tâche <b>${over.id}</b>`,
            description: 'Écrire la page',
            checklist: [
                {
                    id: 'a',
                    label: 'Maquette',
                    done: true,
                    assigneeUserId: null,
                    required: false,
                    createdAt: null,
                    doneAt: null,
                    doneBy: null
                }
            ]
        }),
        created: 1,
        updated: 1,
        ...over
    };
}

const MILESTONE: ProjectMilestoneRow = {
    id: 50,
    project_id: 1,
    workspace_id: 1,
    due_date: 2_000,
    reached_at: null,
    sort_order: 0,
    content: JSON.stringify({ name: 'Lancement', description: '', color: 'green' }),
    created: 1
};

function mount(
    projects: ProjectRow[],
    publications: StoredPublication[],
    domains: readonly SdkDomain[] = [],
    paused: Record<string, string[]> = {}
) {
    const lookups = { byRef: 0, boards: 0 };
    const publicationRepo = memoryPublicationRepo(() => projects);
    publicationRepo.rows.push(...publications);
    const findByRef = publicationRepo.findByRef;
    const repo = {
        projects: {
            findById: async (id: number, ws: number) =>
                projects.find((p) => p.id === id && p.workspace_id === ws) ?? null
        },
        board: {
            listColumns: async (projectId: number) => COLUMNS.map((c) => ({ ...c, project_id: projectId })),
            listCards: async (projectId: number) => {
                lookups.boards += 1;
                return [
                    card({ id: 1, column_id: 10 }),
                    card({ id: 2, column_id: 11, assignee_user_id: 99, milestone_id: null }),
                    card({ id: 3, column_id: 10, archived_at: 5 })
                ].map((c) => ({ ...c, project_id: projectId }));
            }
        },
        plan: { listMilestones: async () => [MILESTONE] },
        publication: {
            ...publicationRepo,
            findByRef: async (ref: string) => {
                lookups.byRef += 1;
                return findByRef(ref);
            }
        }
    } as unknown as ProjectsRepo;
    const deps = createTestServiceDeps({
        repo,
        domains,
        pausedItems: paused,
        members: {
            1: [
                { userId: 7, name: 'Alice Martin', isOwner: true, color: 'blue' },
                // Une teinte hors de la palette, telle qu'une base altérée la rendrait.
                { userId: 99, name: 'Zoé', isOwner: false, color: '"><script>' as 'blue' }
            ]
        }
    });
    const pages = createPublicPages(deps);
    const handlers = new Map<string, (req: SdkPublicRequest, res: SdkPublicReply) => Promise<unknown>>();
    const app: SdkPublicApp = {
        get: (path, _opts, handler) => handlers.set(path, handler),
        post: () => undefined,
        postStream: () => undefined
    };
    pages.routes(app);
    const get = async (path: string, over: Partial<SdkPublicRequest> = {}) => {
        const res = reply();
        await handlers.get(path)!(
            { headers: {}, host: 'public.deveye.test', body: undefined, ip: '203.0.113.7', ...over },
            res
        );
        return res.answer;
    };
    const root = async (domain: SdkDomain) => {
        const res = reply();
        await pages.root({ headers: {}, host: domain.host, body: undefined, ip: '203.0.113.7' }, res, domain);
        return res.answer;
    };
    return { pages, get, root, lookups, publications: publicationRepo.rows };
}

const board = (m: ReturnType<typeof mount>, over: Partial<SdkPublicRequest> = {}) =>
    m.get('/projet/:ref', { params: { ref: REF }, ...over });

describe('le tableau public', () => {
    it('se rend sous l’adresse de DevEye, avec sa politique et hors des moteurs de recherche', async () => {
        const res = await board(mount([project({ id: 1 })], [publication({ project_id: 1 })]));
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'] ?? '', /text\/html/);
        assert.match(res.headers['content-security-policy'] ?? '', /default-src 'none'/);
        assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
        assert.ok(res.body.includes('Projet &lt;1&gt;'));
        assert.ok(res.body.includes('Tâche &lt;b&gt;1&lt;/b&gt;'));
        assert.ok(!res.body.includes('<b>1</b>'));
        assert.ok(res.body.includes('À faire'));
        assert.ok(res.body.includes('1 tâche terminée sur 2'));
        assert.ok(res.body.includes('<script src="/projet/page.js" defer></script>'));
        // Une tâche archivée ne sort pas.
        assert.ok(!res.body.includes('Tâche &lt;b&gt;3'));
    });

    it('tait échéances, jalons et personnes tant que les options sont fermées', async () => {
        const closed = await board(mount([project({ id: 1 })], [publication({ project_id: 1 })]));
        assert.ok(!closed.body.includes('Lancement'));
        assert.ok(!closed.body.includes('Échéance'));
        assert.ok(!closed.body.includes('Alice'));

        const open = await board(
            mount([project({ id: 1 })], [publication({ project_id: 1, show_dates: 1, show_assignees: 1 })])
        );
        assert.ok(open.body.includes('Lancement'));
        assert.ok(open.body.includes('hue-green'));
        assert.ok(open.body.includes('due--late'));
        assert.ok(open.body.includes('Alice Martin'));
        assert.ok(open.body.includes('>AM<'));
        assert.ok(open.body.includes('Zoé'));
        assert.ok(!open.body.includes('"><script>'));
    });

    it('suit le visiteur par défaut, et pose le thème et l’accent choisis', async () => {
        const auto = await board(mount([project({ id: 1 })], [publication({ project_id: 1 })]));
        assert.ok(auto.body.includes('<html lang="fr">'));
        assert.ok(auto.body.includes('content="light dark"'));

        const chosen = await board(
            mount([project({ id: 1 })], [publication({ project_id: 1, theme: 'dark', accent: 'purple' })])
        );
        assert.ok(chosen.body.includes('<html lang="fr" data-theme="dark">'));
        assert.ok(chosen.body.includes('--accent: #b088ff;'));

        // Un accent abîmé en base retombe sur celui de la page, sans rien écrire de lui.
        const broken = await board(
            mount([project({ id: 1 })], [publication({ project_id: 1, theme: 'sepia', accent: '#000;}body{' })])
        );
        assert.ok(broken.body.includes('<html lang="fr">'));
        assert.ok(!broken.body.includes('body{'));
    });

    it('ne déplie les cartes qu’avec l’option, et seulement celles qui ont des sous-tâches', async () => {
        const closed = await board(mount([project({ id: 1 })], [publication({ project_id: 1 })]));
        assert.ok(!closed.body.includes('<details'));
        assert.ok(!closed.body.includes('Maquette'));

        const open = await board(mount([project({ id: 1 })], [publication({ project_id: 1, show_subtasks: 1 })]));
        assert.ok(open.body.includes('<details data-card="1"><summary>'));
        assert.ok(open.body.includes('Maquette'));
        assert.ok(open.body.includes('(terminée)'));
        // Rien dans le résumé qui n'y soit admis : pas de bloc, pas de titre.
        const summary = /<summary>([\s\S]*?)<\/summary>/.exec(open.body)?.[1] ?? '';
        assert.ok(!/<(div|p|h3|ul|li)[\s>]/.test(summary));
    });

    it('ne laisse jamais sortir la discussion', async () => {
        const res = await board(
            mount([project({ id: 1 })], [publication({ project_id: 1, show_dates: 1, show_assignees: 1 })])
        );
        assert.ok(!/message/i.test(res.body.replace(/<script[\s\S]*?<\/script>/g, '')));
    });

    it('répond « introuvable » pareil pour un lien inconnu, une page fermée, un projet gardé ou en pause', async () => {
        const unknown = await board(mount([project({ id: 1 })], []));
        const closed = await board(mount([project({ id: 1 })], [publication({ project_id: 1, enabled: 0 })]));
        const guarded = await board(
            mount([project({ id: 1, security_tier: 'guarded' })], [publication({ project_id: 1 })])
        );
        const paused = await board(
            mount([project({ id: 1 })], [publication({ project_id: 1 })], [], { pages: ['public:1'] })
        );
        const malformed = await board(mount([project({ id: 1 })], [publication({ project_id: 1 })]), {
            params: { ref: '../admin' }
        });
        for (const res of [unknown, closed, guarded, paused, malformed]) {
            assert.equal(res.status, 404);
            assert.ok(res.body.includes('Page introuvable'));
        }
        assert.equal(closed.body, unknown.body);
    });

    it('se montre sous un domaine de son espace, jamais sous celui d’un autre', async () => {
        const domains = [
            testDomain({ id: 5, host: 'roadmap.exemple.fr', workspaceId: 1 }),
            testDomain({ id: 6, host: 'roadmap.autre.fr', workspaceId: 42 }),
            testDomain({ id: 7, host: 'attente.exemple.fr', workspaceId: 1, verified: false })
        ];
        const m = mount([project({ id: 1 })], [publication({ project_id: 1 })], domains);
        const own = await board(m, { host: 'roadmap.exemple.fr' });
        assert.equal(own.status, 200);
        assert.equal(own.headers['x-robots-tag'], undefined);
        assert.equal((await board(m, { host: 'roadmap.autre.fr' })).status, 404);
        assert.equal((await board(m, { host: 'attente.exemple.fr' })).status, 404);
        assert.equal((await board(m, { host: 'nimporte.quoi' })).status, 404);
    });

    it('se calcule une fois pour les visites suivantes, et se relit après une écriture', async () => {
        const m = mount([project({ id: 1 })], [publication({ project_id: 1 })]);
        await Promise.all([board(m), board(m), board(m)]);
        assert.equal(m.lookups.byRef, 1);
        await board(m);
        assert.equal(m.lookups.byRef, 1);
        m.pages.forget(1);
        await board(m);
        assert.equal(m.lookups.byRef, 2);
    });

    it('sert son script avec un ETag, et 304 quand le navigateur l’a déjà', async () => {
        const m = mount([], []);
        const first = await m.get('/projet/page.js');
        assert.equal(first.headers.etag, BOARD_SCRIPT_ETAG);
        const again = await m.get('/projet/page.js', { headers: { 'if-none-match': BOARD_SCRIPT_ETAG } });
        assert.equal(again.status, 304);
    });
});

describe('un domaine, plusieurs projets', () => {
    const domain = testDomain({ id: 5, host: 'roadmap.exemple.fr', workspaceId: 1 });
    const two = () => [
        publication({ project_id: 1, domain_id: 5, slug: 'site-web', domain_at: 100 }),
        publication({ project_id: 2, public_ref: OTHER_REF, domain_id: 5, slug: 'appli', domain_at: 200 })
    ];

    it('donne la racine au plus ancien sur le domaine, et un chemin à chacun', async () => {
        const m = mount([project({ id: 1 }), project({ id: 2 })], two(), [domain]);
        assert.ok((await m.root(domain)).body.includes('Projet &lt;1&gt;'));
        const second = await board(m, { host: domain.host, params: { ref: 'appli' } });
        assert.equal(second.status, 200);
        assert.ok(second.body.includes('Projet &lt;2&gt;'));
        assert.ok(
            (await board(m, { host: domain.host, params: { ref: 'site-web' } })).body.includes('Projet &lt;1&gt;')
        );
    });

    it('passe la racine au suivant quand le premier ferme ou se met en pause, sans rien oublier', async () => {
        const paused: string[] = [];
        const m = mount([project({ id: 1 }), project({ id: 2 })], two(), [domain], { pages: paused });
        assert.ok((await m.root(domain)).body.includes('Projet &lt;1&gt;'));

        paused.push('public:1');
        assert.ok((await m.root(domain)).body.includes('Projet &lt;2&gt;'));
        paused.length = 0;

        m.publications[0].enabled = 0;
        m.pages.forget(1);
        assert.ok((await m.root(domain)).body.includes('Projet &lt;2&gt;'));
        // Son chemin ne répond plus, celui du suivant toujours.
        assert.equal((await board(m, { host: domain.host, params: { ref: 'site-web' } })).status, 404);
        assert.equal((await board(m, { host: domain.host, params: { ref: 'appli' } })).status, 200);
    });

    it('ne sert pas sous un domaine le chemin d’un projet d’un autre espace', async () => {
        const foreign = testDomain({ id: 5, host: 'roadmap.exemple.fr', workspaceId: 42 });
        const m = mount(
            [project({ id: 1 })],
            [publication({ project_id: 1, domain_id: 5, slug: 'site-web' })],
            [foreign]
        );
        assert.equal((await board(m, { host: foreign.host, params: { ref: 'site-web' } })).status, 404);
        assert.equal((await m.root(foreign)).status, 404);
    });

    it('répond « introuvable » à la racine d’un domaine sans projet en ligne', async () => {
        const m = mount(
            [project({ id: 1 })],
            [publication({ project_id: 1, enabled: 0, domain_id: 5, slug: 'x' })],
            [domain]
        );
        const res = await m.root(domain);
        assert.equal(res.status, 404);
        assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    });
});
