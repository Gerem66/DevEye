import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import type { DeployCredentialRow, DeploymentRow, DeployTargetRow } from '../contracts/domain';
import { DEPLOY_ITEMS_PROVIDER, type DeployItemsProvider } from '@deveye/types/sdk';
import { createTestServiceDeps, testDevice } from '@deveye/types/sdk/testing';

import { DokployProvider, type DokployClient, type DokployTarget } from './providers/dokploy';
import { GithubProvider } from './providers/github';
import { ProviderError, type RemoteDeployment } from './providers/types';
import { serverEntry } from './index';
import type { DeployRepo } from './repo';
import { DeploySync } from './service';

/**
 * Le rapprochement de fond du module, sur le harnais de service du SDK, avec un
 * adaptateur Dokploy injecté : le premier import garnit sans prévenir, un
 * déploiement en vol ouvre un message vivant puis le modifie (jamais un second),
 * l'atterrissage conclut et n'envoie l'avis en texte qu'aux autres canaux
 * (`except`), un suivi perdu passe à `failed` sans avis, et `live.changed` ne
 * part qu'à un changement.
 */

interface FakeRepo extends DeployRepo {
    targets: DeployTargetRow[];
    deployments: DeploymentRow[];
    credentials: DeployCredentialRow[];
}

const NOW = () => Math.floor(Date.now() / 1000);

function target(over: Partial<DeployTargetRow> = {}): DeployTargetRow {
    return {
        id: 1,
        workspace_id: 1,
        credential_id: 10,
        device_id: null,
        provider: 'dokploy',
        target_kind: 'application',
        external_id: 'app-1',
        sort_order: 0,
        content: JSON.stringify({ name: 'Serveur' }),
        synced_at: 100,
        created: 1,
        ...over
    };
}

function credential(over: Partial<DeployCredentialRow> = {}): DeployCredentialRow {
    return {
        id: 10,
        workspace_id: 1,
        provider: 'dokploy',
        label: 'Prod',
        base_url: 'https://dokploy.exemple.fr',
        device_id: null,
        author_user_id: null,
        secret_enc: 'clé',
        unreachable_since: null,
        unreachable_error: null,
        unreachable_notified: 0,
        created: 1,
        ...over
    };
}

function entry(over: Partial<RemoteDeployment> = {}): RemoteDeployment {
    return {
        externalId: 'dep-1',
        status: 'running',
        title: 'feat: mise en prod',
        description: '',
        startedAt: NOW() - 30,
        finishedAt: null,
        logRef: '/logs/dep-1',
        url: null,
        details: [],
        ...over
    };
}

/** Le service sur une instance Dokploy simulée ; GitHub reste le vrai, jamais appelé ici. */
function withDokploy(client: Partial<DokployClient>) {
    const unused = async () => {
        throw new Error('non attendu ici');
    };
    return {
        dokploy: new DokployProvider({
            listTargets: unused,
            listDeployments: unused,
            triggerDeploy: unused,
            fetchDeploymentLog: unused,
            fetchRepoUrl: unused,
            ...client
        }),
        github: new GithubProvider()
    };
}

/** Un dépôt en mémoire ; le harnais chiffre à l'identité, donc les blobs sont le JSON en clair. */
function fakeRepo(
    targets: DeployTargetRow[],
    credentials: DeployCredentialRow[],
    deployments: DeploymentRow[] = []
): FakeRepo {
    let seq = 100;
    const unused = async () => {
        throw new Error('non attendu ici');
    };
    return {
        targets,
        deployments,
        credentials,
        listTargets: unused,
        listVisibleTargets: unused,
        findTarget: async (id, workspaceId) =>
            targets.find((t) => t.id === id && t.workspace_id === workspaceId) ?? null,
        findVisibleTarget: async (id, workspaceId) =>
            targets.find((t) => t.id === id && t.workspace_id === workspaceId) ?? null,
        findTargetWithUsage: unused,
        findVisibleTargetWithUsage: unused,
        findTargetByExternal: unused,
        countTargets: unused,
        createTarget: unused,
        updateTarget: unused,
        deleteTarget: unused,
        reorderTargets: unused,
        listCredentials: unused,
        findCredential: async (id, workspaceId) =>
            credentials.find((c) => c.id === id && c.workspace_id === workspaceId) ?? null,
        createCredential: unused,
        updateCredential: unused,
        removeCredential: unused,
        countCredentialUses: unused,
        markCredentialUnreachable: async (id, { since, error }) => {
            const c = credentials.find((x) => x.id === id);
            if (!c) return;
            c.unreachable_since ??= since;
            c.unreachable_error = error;
        },
        markCredentialNotified: async (id) => {
            const c = credentials.find((x) => x.id === id);
            if (c) c.unreachable_notified = 1;
        },
        clearCredentialUnreachable: async (id) => {
            const c = credentials.find((x) => x.id === id);
            if (!c) return;
            c.unreachable_since = null;
            c.unreachable_error = null;
            c.unreachable_notified = 0;
        },
        listTargetsOfCredential: async (credentialId) =>
            targets
                .filter((t) => t.credential_id === credentialId)
                .map((t) => ({ id: t.id, workspace_id: t.workspace_id, content: t.content })),
        findTargetByDevice: unused,
        countTargetsInWorkspaces: async (ids) => targets.filter((t) => ids.includes(t.workspace_id)).length,
        listStockTargets: unused,
        // La requête du vrai dépôt, en mémoire : jointure sur la clé, accès
        // écartés, compte des déploiements en vol, les deux régimes, le tour de
        // chaque espace et l'ordre.
        listTargetsDue: async (limit, staleBefore, skipCredentialIds, pausedIds) => {
            const due = targets
                .filter((t) => t.credential_id === null || !skipCredentialIds.includes(t.credential_id))
                .filter((t) => !pausedIds.includes(t.id))
                .map((t) => {
                    const c = credentials.find((x) => x.id === t.credential_id);
                    return {
                        ...t,
                        base_url: c?.base_url ?? null,
                        in_flight: deployments.filter(
                            (d) => d.target_id === t.id && (d.status === 'queued' || d.status === 'running')
                        ).length
                    };
                })
                .filter((t) => t.base_url)
                .filter((t) => t.in_flight > 0 || t.synced_at === null || t.synced_at < staleBefore)
                .sort((a, b) => b.in_flight - a.in_flight || a.id - b.id);
            const seen = new Map<number, number>();
            return due
                .map((t) => {
                    const turn = (seen.get(t.workspace_id) ?? 0) + 1;
                    seen.set(t.workspace_id, turn);
                    return { t, turn };
                })
                .sort((a, b) => a.turn - b.turn)
                .map(({ t }) => t)
                .slice(0, limit);
        },
        markTargetSynced: async (id, at) => {
            const t = targets.find((x) => x.id === id);
            if (t) t.synced_at = at;
        },
        createDeployment: unused,
        async createRemoteDeployment(input) {
            const row: DeploymentRow = {
                id: ++seq,
                target_id: input.targetId,
                workspace_id: input.workspaceId,
                external_id: input.externalId,
                status: input.status,
                triggered_by_user_id: null,
                started_at: input.startedAt,
                finished_at: input.finishedAt,
                notified: input.notified ? 1 : 0,
                content: input.content
            };
            deployments.push(row);
            return { ...row };
        },
        updateDeployment: async (id, input) => {
            const d = deployments.find((x) => x.id === id);
            if (!d) return;
            d.external_id = input.externalId;
            d.status = input.status;
            d.finished_at = input.finishedAt;
            d.content = input.content;
        },
        markDeploymentNotified: async (id) => {
            const d = deployments.find((x) => x.id === id);
            if (d) d.notified = 1;
        },
        setDeploymentContent: async (id, content) => {
            const d = deployments.find((x) => x.id === id);
            if (d) d.content = content;
        },
        // Des copies, comme des lignes lues en base : le service compare l'état
        // d'AVANT le tour à ce qu'il écrit.
        listDeployments: async (targetId, workspaceId, limit) =>
            deployments
                .filter((d) => d.target_id === targetId && d.workspace_id === workspaceId)
                .sort((a, b) => b.started_at - a.started_at || b.id - a.id)
                .slice(0, limit)
                .map((d) => ({ ...d })),
        findDeployment: async (id) => {
            const d = deployments.find((x) => x.id === id);
            return d ? { ...d } : null;
        },
        listInFlightAgentDeployments: async () =>
            deployments
                .filter((d) => d.status === 'queued' || d.status === 'running')
                .filter((d) => targets.find((t) => t.id === d.target_id)?.provider === 'agent')
                .map((d) => ({ ...d }))
    };
}

/** Ce que l'instance factice répond : l'historique de la cible, son catalogue, la queue d'un journal, le dépôt. */
interface Answers {
    remote: RemoteDeployment[];
    catalog?: DokployTarget[];
    log?: string;
    repoUrl?: string | null;
}

/** Le service sur le harnais, avec une instance Dokploy pilotée par le test. */
function syncWith(
    repo: FakeRepo,
    options: {
        liveChannels?: readonly number[];
        notifyAccepted?: boolean;
        pausedItems?: Record<string, readonly string[]>;
    } = {}
) {
    const deps = createTestServiceDeps({ repo, ...options });
    /** Ce que l'instance répond ; `null` = injoignable, une erreur = ce refus précis. */
    let answers: Answers | Error | null = { remote: [] };
    const answerOrThrow = (): Answers => {
        if (answers === null) throw new ProviderError('Instance Dokploy injoignable', 0);
        if (answers instanceof Error) throw answers;
        return answers;
    };
    /** Lectures de la fiche d'une cible : une par cible et par heure, pas une par tour. */
    let repoReads = 0;
    const sync = new DeploySync(
        deps,
        withDokploy({
            listDeployments: async () => answerOrThrow().remote,
            listTargets: async () => (answers && !(answers instanceof Error) ? answers.catalog : null) ?? [],
            fetchDeploymentLog: async () => (answers && !(answers instanceof Error) ? answers.log : null) ?? '',
            fetchRepoUrl: async () => {
                repoReads += 1;
                return answerOrThrow().repoUrl ?? null;
            }
        })
    );
    return {
        deps,
        sync,
        repoReads: () => repoReads,
        /** Un battement, et l'attente des rapprochements qu'il a lancés. */
        tick: async () => {
            await deps.recorded.tickers[0].tick();
            await sync.idle();
        },
        /** Ce que l'instance répond au prochain tour ; `null` = injoignable, une erreur = ce refus. */
        answer(next: Answers | Error | null) {
            answers = next;
        }
    };
}

const noticeIdsOf = (row: DeploymentRow): Record<string, string> =>
    (JSON.parse(row.content) as { noticeIds?: Record<string, string> }).noticeIds ?? {};

describe('la boucle', () => {
    it('pose un ticker à dix secondes, et un premier import garnit sans prévenir', async () => {
        const repo = fakeRepo([target({ synced_at: null })], [credential()]);
        const { deps, tick, answer } = syncWith(repo, { liveChannels: [7] });
        assert.deepEqual(
            deps.recorded.tickers.map((t) => t.intervalMs),
            [10_000]
        );
        answer({
            remote: [
                entry({ externalId: 'dep-1', status: 'success', startedAt: 1_000, finishedAt: 1_060 }),
                entry({ externalId: 'dep-2', status: 'failed', startedAt: 2_000, finishedAt: 2_005 })
            ]
        });
        await tick();

        // Tout l'historique entre en base marqué annoncé : rien ne part, et le
        // premier import est fait.
        assert.deepEqual(
            repo.deployments.map((d) => [d.external_id, d.status, d.notified]),
            [
                ['dep-2', 'failed', 1],
                ['dep-1', 'success', 1]
            ]
        );
        assert.equal(deps.recorded.notifications.length, 0);
        assert.equal(deps.recorded.liveMessages.length, 0);
        assert.notEqual(repo.targets[0].synced_at, null);
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });

    it('une instance injoignable recule en mémoire : le premier import reste à faire, la boucle continue', async () => {
        const repo = fakeRepo([target({ synced_at: null })], [credential()]);
        const { deps, tick, answer } = syncWith(repo);
        answer(null);
        await tick();
        assert.equal(repo.targets[0].synced_at, null);
        assert.deepEqual(deps.recorded.liveChanges, []);
    });
});

describe('le lien avec l’instance', () => {
    /**
     * Le recul d'un accès est en secondes réelles : l'horloge est simulée, et
     * chaque tour la pousse au-delà du recul en cours (60 s, 120 s, 240 s…).
     */
    function withClock<T>(run: (advance: (seconds: number) => void) => Promise<T>): Promise<T> {
        mock.timers.enable({ apis: ['Date'], now: Date.now() });
        return run((seconds) => mock.timers.tick(seconds * 1000)).finally(() => mock.timers.reset());
    }

    const twoTargets = () =>
        fakeRepo(
            [
                target({ id: 1, synced_at: 100, content: JSON.stringify({ name: 'Site' }) }),
                target({ id: 2, synced_at: 100, content: JSON.stringify({ name: 'API' }) })
            ],
            [credential()]
        );

    /** Trois tours en échec, le recul respecté entre deux. */
    async function failThrice(tick: () => Promise<void>, advance: (seconds: number) => void): Promise<void> {
        await tick();
        advance(61);
        await tick();
        advance(121);
        await tick();
    }

    it('trois échecs consécutifs marquent l’accès et le disent une fois, sur la route de la fonctionnalité', () =>
        withClock(async (advance) => {
            const repo = twoTargets();
            const { deps, tick, answer } = syncWith(repo);
            answer(null);

            await tick();
            advance(61);
            await tick();
            assert.equal(repo.credentials[0].unreachable_since, null, 'deux échecs ne disent rien encore');
            assert.equal(deps.recorded.notifications.length, 0);

            advance(121);
            await tick();
            assert.notEqual(repo.credentials[0].unreachable_since, null);
            assert.equal(repo.credentials[0].unreachable_error, 'Instance Dokploy injoignable');
            assert.equal(repo.credentials[0].unreachable_notified, 1);
            // Un seul avis pour l'accès, sans cible : la route de la fonctionnalité.
            assert.deepEqual(
                deps.recorded.notifications.map((n) => [n.itemId, n.subject]),
                [[undefined, '[DevEye] Lien perdu avec l’instance de « Prod »']]
            );
            const body = deps.recorded.notifications[0].body;
            assert.match(body, /Cibles : Site, API/);
            assert.match(body, /Cause : Instance Dokploy injoignable/);
            assert.equal(deps.recorded.notifications[0].embeds, 1);
            assert.deepEqual(deps.recorded.liveChanges, [1]);

            // Un quatrième échec ne répète pas l'avis.
            advance(241);
            await tick();
            assert.equal(deps.recorded.notifications.length, 1);
        }));

    it('le retour efface la ligne et se dit à qui a entendu la perte', () =>
        withClock(async (advance) => {
            const repo = twoTargets();
            const { deps, tick, answer } = syncWith(repo);
            answer(null);
            await failThrice(tick, advance);
            assert.equal(deps.recorded.notifications.length, 1);

            answer({ remote: [] });
            advance(241);
            await tick();
            assert.equal(repo.credentials[0].unreachable_since, null);
            assert.equal(repo.credentials[0].unreachable_notified, 0);
            assert.deepEqual(
                deps.recorded.notifications.slice(1).map((n) => [n.itemId, n.subject]),
                [[undefined, '[DevEye] Lien rétabli avec l’instance de « Prod »']]
            );
        }));

    it('une perte qu’aucun canal n’a acceptée n’a pas de retour', () =>
        withClock(async (advance) => {
            const repo = twoTargets();
            const { deps, tick, answer } = syncWith(repo, { notifyAccepted: false });
            answer(null);
            await failThrice(tick, advance);
            assert.equal(repo.credentials[0].unreachable_notified, 0);

            answer({ remote: [] });
            advance(241);
            await tick();
            assert.equal(repo.credentials[0].unreachable_since, null);
            assert.ok(deps.recorded.notifications.every((n) => n.subject.includes('perdu')));
        }));

    it('une limite de débit ou une cible en défaut ne sont pas un lien perdu', () =>
        withClock(async (advance) => {
            for (const refusal of [
                new ProviderError('Trop de requêtes', 429, NOW() + 5),
                new ProviderError('Dokploy a répondu 500.', 500)
            ]) {
                const repo = twoTargets();
                const { deps, tick, answer } = syncWith(repo);
                answer(refusal);
                await failThrice(tick, advance);
                advance(241);
                await tick();
                assert.equal(repo.credentials[0].unreachable_since, null, refusal.message);
                assert.equal(deps.recorded.notifications.length, 0, refusal.message);
            }
        }));

    it('une clé refusée ou un relais fermé comptent comme un lien perdu', () =>
        withClock(async (advance) => {
            for (const refusal of [
                new ProviderError('Dokploy a répondu 401.', 401),
                new ProviderError('L’appareil « Serveur » est hors ligne.', 0)
            ]) {
                const repo = twoTargets();
                const { deps, tick, answer } = syncWith(repo);
                answer(refusal);
                await failThrice(tick, advance);
                assert.equal(repo.credentials[0].unreachable_error, refusal.message);
                assert.equal(deps.recorded.notifications.length, 1, refusal.message);
            }
        }));

    it('après un redémarrage, une perte déjà en base ne se redit pas, mais son retour part', () =>
        withClock(async (advance) => {
            const repo = fakeRepo(
                [target({ id: 1, synced_at: 100, content: JSON.stringify({ name: 'Site' }) })],
                [
                    credential({
                        unreachable_since: NOW() - 600,
                        unreachable_error: 'Instance Dokploy injoignable',
                        unreachable_notified: 1
                    })
                ]
            );
            const { deps, tick, answer } = syncWith(repo);
            answer(null);
            await failThrice(tick, advance);
            assert.equal(deps.recorded.notifications.length, 0);

            answer({ remote: [] });
            advance(241);
            await tick();
            assert.deepEqual(
                deps.recorded.notifications.map((n) => [n.itemId, n.subject]),
                [[undefined, '[DevEye] Lien rétabli avec l’instance de « Prod »']]
            );
        }));
});

describe('la pause d’offre', () => {
    it('une cible en pause n’est pas sondée, même avec un déploiement en vol ; les autres le sont', async () => {
        const inFlight: DeploymentRow = {
            id: 5,
            target_id: 2,
            workspace_id: 1,
            external_id: 'dep-1',
            status: 'running',
            triggered_by_user_id: 3,
            started_at: NOW() - 30,
            finished_at: null,
            notified: 0,
            content: JSON.stringify({ title: 'Mise en prod', description: '', url: null })
        };
        const repo = fakeRepo(
            [
                target({ id: 1, synced_at: null }),
                target({ id: 2, credential_id: 20, external_id: 'app-2', synced_at: null })
            ],
            [credential(), credential({ id: 20, base_url: 'https://autre.fr' })],
            [inFlight]
        );
        const { tick, answer } = syncWith(repo, { pausedItems: { targets: ['2'] } });
        answer({ remote: [] });
        await tick();
        assert.notEqual(repo.targets[0].synced_at, null);
        assert.equal(repo.targets[1].synced_at, null);
        assert.equal(repo.deployments[0].status, 'running');
    });
});

describe('le message vivant', () => {
    it('ouvre un message pour un déploiement en vol, le modifie au tour suivant, puis conclut et n’envoie l’avis qu’aux autres canaux', async () => {
        const repo = fakeRepo([target()], [credential()]);
        const { deps, tick, answer } = syncWith(repo, { liveChannels: [7] });

        // Découvert en vol : la ligne entre non annoncée, le message s'ouvre et
        // son identifiant est retenu.
        answer({ remote: [entry()], log: 'étape 1\n' });
        await tick();
        assert.deepEqual(
            repo.deployments.map((d) => [d.external_id, d.status, d.notified]),
            [['dep-1', 'running', 0]]
        );
        assert.deepEqual(deps.recorded.liveMessages, [{ channelId: 7, messageId: null, embeds: 1 }]);
        assert.deepEqual(noticeIdsOf(repo.deployments[0]), { '7': 'live-1' });
        assert.equal(deps.recorded.notifications.length, 0);
        assert.deepEqual(deps.recorded.liveChanges, [1]);

        // Toujours en vol : le même message se modifie, aucun état n'a changé,
        // donc l'espace n'est pas re-prévenu.
        answer({ remote: [entry()], log: 'étape 1\nétape 2\n' });
        await tick();
        assert.deepEqual(deps.recorded.liveMessages.at(-1), { channelId: 7, messageId: 'live-1', embeds: 1 });
        assert.deepEqual(noticeIdsOf(repo.deployments[0]), { '7': 'live-1' });
        assert.deepEqual(deps.recorded.liveChanges, [1]);

        // Atterrissage : l'édition finale du même message, puis l'avis en texte
        // sauf au canal qui a déjà tout dit.
        const finishedAt = NOW();
        answer({ remote: [entry({ status: 'success', finishedAt })] });
        await tick();
        assert.deepEqual(
            repo.deployments.map((d) => [d.status, d.finished_at, d.notified]),
            [['success', finishedAt, 1]]
        );
        assert.deepEqual(deps.recorded.liveMessages.at(-1), { channelId: 7, messageId: 'live-1', embeds: 1 });
        assert.equal(deps.recorded.liveMessages.length, 3);
        assert.deepEqual(
            deps.recorded.notifications.map((n) => [n.itemId, n.except, n.subject]),
            [[1, [7], '[DevEye] Succès du déploiement : Serveur']]
        );
        assert.deepEqual(deps.recorded.liveChanges, [1, 1]);

        // Rien ne repart au tour suivant : l'avis appartient au déploiement.
        await tick();
        assert.equal(deps.recorded.notifications.length, 1);
        assert.equal(deps.recorded.liveMessages.length, 3);
    });

    it('ne lit la fiche de la cible qu’une fois, quel que soit le nombre de battements', async () => {
        // Elle porte le dépôt, mais aussi les identifiants du fournisseur Git :
        // un appel par tour de dix secondes serait aussi coûteux qu'inutile.
        const repo = fakeRepo([target()], [credential()]);
        const { tick, answer, repoReads } = syncWith(repo, { liveChannels: [7] });
        answer({ remote: [entry()], repoUrl: 'https://github.com/OxyFoo/Pierre' });
        await tick();
        await tick();
        await tick();
        assert.equal(repoReads(), 1);
    });

    it('un déploiement conclu entre deux battements reçoit le même message, publié une seule fois', async () => {
        const repo = fakeRepo([target()], [credential()]);
        const { deps, tick, answer } = syncWith(repo, { liveChannels: [7] });
        answer({ remote: [entry({ status: 'failed', description: 'exit code 1', finishedAt: NOW() })] });
        await tick();
        assert.deepEqual(deps.recorded.liveMessages, [{ channelId: 7, messageId: null, embeds: 1 }]);
        // Rien à retenir : il n'y aura pas de tour suivant pour ce message.
        assert.deepEqual(noticeIdsOf(repo.deployments[0]), {});
        assert.deepEqual(
            deps.recorded.notifications.map((n) => [n.except, n.subject, n.body.includes('exit code 1')]),
            [[[7], '[DevEye] Échec du déploiement : Serveur', true]]
        );
        assert.equal(repo.deployments[0].notified, 1);
    });

    it('sans canal vivant, l’avis en texte part seul, sur la route de la cible', async () => {
        const repo = fakeRepo([target()], [credential()]);
        const { deps, tick, answer } = syncWith(repo);
        answer({ remote: [entry({ status: 'success', finishedAt: NOW() })] });
        await tick();
        assert.equal(deps.recorded.liveMessages.length, 0);
        assert.deepEqual(
            deps.recorded.notifications.map((n) => [n.itemId, n.except]),
            [[1, []]]
        );
        assert.equal(repo.deployments[0].notified, 1);
    });

    it('un canal qui refuse le message n’est pas privé de l’avis en texte', async () => {
        const repo = fakeRepo([target()], [credential()]);
        const { deps, tick, answer } = syncWith(repo, { liveChannels: [7], notifyAccepted: false });
        answer({ remote: [entry({ status: 'success', finishedAt: NOW() })] });
        await tick();
        assert.equal(deps.recorded.liveMessages.length, 1);
        // Le message n'a pas pu s'ouvrir : le canal reste dans la livraison finale.
        assert.deepEqual(
            deps.recorded.notifications.map((n) => n.except),
            [[]]
        );
        assert.deepEqual(noticeIdsOf(repo.deployments[0]), {});
    });
});

describe('le rattachement', () => {
    it('recolle la ligne écrite par deploy.trigger sur l’entrée du fournisseur, par la date puis par l’identifiant', async () => {
        const startedAt = NOW() - 20;
        const local: DeploymentRow = {
            id: 5,
            target_id: 1,
            workspace_id: 1,
            external_id: null,
            status: 'queued',
            triggered_by_user_id: 3,
            started_at: startedAt,
            finished_at: null,
            notified: 0,
            content: JSON.stringify({ title: 'Mise en prod', description: '', url: null })
        };
        const repo = fakeRepo([target()], [credential()], [local]);
        const { deps, tick, answer } = syncWith(repo);

        answer({ remote: [entry({ externalId: 'dep-9', startedAt: startedAt + 5 })] });
        await tick();
        assert.deepEqual(
            repo.deployments.map((d) => [d.id, d.external_id, d.status]),
            [[5, 'dep-9', 'running']]
        );
        assert.deepEqual(deps.recorded.liveChanges, [1]);

        const finishedAt = NOW();
        answer({ remote: [entry({ externalId: 'dep-9', status: 'success', startedAt: startedAt + 5, finishedAt })] });
        await tick();
        assert.deepEqual(
            repo.deployments.map((d) => [d.id, d.status, d.finished_at, d.notified]),
            [[5, 'success', finishedAt, 1]]
        );
        assert.equal(deps.recorded.notifications.length, 1);
    });

    it('un suivi perdu passe à `failed` sans avis, une fois la borne franchie', async () => {
        const stale: DeploymentRow = {
            id: 5,
            target_id: 1,
            workspace_id: 1,
            external_id: null,
            status: 'queued',
            triggered_by_user_id: 3,
            started_at: NOW() - 7 * 3600,
            finished_at: null,
            notified: 0,
            content: JSON.stringify({ title: 'Perdu', description: '', url: null })
        };
        const repo = fakeRepo([target()], [credential()], [stale]);
        const { deps, tick, answer } = syncWith(repo, { liveChannels: [7] });
        answer({ remote: [] });
        await tick();
        assert.deepEqual(
            repo.deployments.map((d) => [
                d.status,
                d.notified,
                (JSON.parse(d.content) as { description: string }).description
            ]),
            [['failed', 1, 'Suivi perdu : le fournisseur ne connaît plus ce déploiement.']]
        );
        assert.equal(deps.recorded.notifications.length, 0);
        assert.equal(deps.recorded.liveMessages.length, 0);
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });
});

/** Le contrat offert à Projets, tel que `createService` le publie au boot. */
function itemsProviderOn(repo: FakeRepo): DeployItemsProvider {
    const service = serverEntry.createService?.(createTestServiceDeps({ repo }));
    assert.ok(service, 'le module crée un service');
    const provider = service.providers?.[DEPLOY_ITEMS_PROVIDER] as DeployItemsProvider | undefined;
    assert.ok(provider, 'le service publie le contrat des éléments');
    return provider;
}

describe('DEPLOY_ITEMS_PROVIDER : labelOf', () => {
    it("rend le nom déchiffré d'une cible vivante, null pour un identifiant inconnu ou un autre espace", async () => {
        const provider = itemsProviderOn(fakeRepo([target()], [credential()]));
        assert.equal(await provider.labelOf(1, 1), 'Serveur');
        assert.equal(await provider.labelOf(42, 1), null);
        assert.equal(await provider.labelOf(1, 2), null);
    });
});

/** Une instance par adresse : chaque test dit ce que répond chacune, ou la laisse pendre. */
function syncByInstance(repo: FakeRepo, options: { liveChannels?: readonly number[] } = {}) {
    const deps = createTestServiceDeps({ repo, ...options });
    const calls: string[] = [];
    const answers = new Map<string, RemoteDeployment[] | Error | Promise<never>>();
    const sync = new DeploySync(
        deps,
        withDokploy({
            listDeployments: async ({ baseUrl }, _kind, externalId) => {
                calls.push(`${baseUrl}#${externalId}`);
                const answer = answers.get(baseUrl) ?? [];
                if (answer instanceof Error) throw answer;
                return answer;
            },
            listTargets: async () => [],
            fetchDeploymentLog: async () => '',
            fetchRepoUrl: async () => null
        })
    );
    return { deps, sync, calls, answers, beat: () => deps.recorded.tickers[0].tick() };
}

describe('le partage entre accès et espaces', () => {
    it('une instance qui pend ne retient pas les cibles des autres', async () => {
        const repo = fakeRepo(
            [target({ id: 1, credential_id: 10 }), target({ id: 2, workspace_id: 2, credential_id: 20 })],
            [
                credential({ id: 10, base_url: 'https://lente.fr' }),
                credential({ id: 20, workspace_id: 2, base_url: 'https://vive.fr' })
            ]
        );
        const { sync, calls, answers, beat } = syncByInstance(repo);
        let release: () => void = () => undefined;
        answers.set(
            'https://lente.fr',
            new Promise<never>((_, reject) => {
                release = () => reject(new Error('délai dépassé'));
            })
        );
        answers.set('https://vive.fr', []);
        await beat();
        // La cible saine a abouti pendant que l'autre pend encore.
        await new Promise((resolve) => setImmediate(resolve));
        assert.notEqual(repo.targets[1].synced_at, 100);
        assert.equal(repo.targets[0].synced_at, 100);

        // Un second battement ne relance pas la cible encore en vol.
        await beat();
        assert.equal(calls.filter((c) => c.startsWith('https://lente.fr')).length, 1);
        release();
        await sync.idle();
    });

    it('sert les espaces à tour de rôle', async () => {
        const crowded = Array.from({ length: 20 }, (_, i) =>
            target({ id: i + 1, credential_id: 100 + i, synced_at: null })
        );
        const repo = fakeRepo(
            [...crowded, target({ id: 50, workspace_id: 2, credential_id: 200, synced_at: null })],
            [
                ...crowded.map((t) => credential({ id: t.credential_id ?? 0, base_url: `https://i${t.id}.fr` })),
                credential({ id: 200, workspace_id: 2, base_url: 'https://seul.fr' })
            ]
        );
        const { sync, calls, beat } = syncByInstance(repo);
        await beat();
        await sync.idle();
        // Seize places, vingt cibles d'un espace devant : celle de l'autre espace passe quand même.
        assert.equal(calls.length, 16);
        assert.ok(calls.includes('https://seul.fr#app-1'));
    });

    it('recule par accès : toutes les cibles d’une instance muette attendent, les autres continuent', async () => {
        const repo = fakeRepo(
            [
                target({ id: 1, credential_id: 10, synced_at: null }),
                target({ id: 2, credential_id: 10, external_id: 'app-2', synced_at: null }),
                target({ id: 3, credential_id: 20, synced_at: null })
            ],
            [credential({ id: 10, base_url: 'https://muette.fr' }), credential({ id: 20, base_url: 'https://vive.fr' })]
        );
        const { sync, calls, answers, beat } = syncByInstance(repo);
        answers.set('https://muette.fr', new Error('Instance Dokploy injoignable'));
        await beat();
        await sync.idle();
        await beat();
        await sync.idle();
        // Une seule tentative vers l'instance muette, jamais sa seconde cible.
        assert.deepEqual(
            calls.filter((c) => c.startsWith('https://muette.fr')),
            ['https://muette.fr#app-1']
        );
        assert.notEqual(repo.targets[2].synced_at, null);
    });

    it('une instance muette ne garde pas un déploiement en cours au-delà de la borne', async () => {
        const stale: DeploymentRow = {
            id: 5,
            target_id: 1,
            workspace_id: 1,
            external_id: 'dep-1',
            status: 'running',
            triggered_by_user_id: 3,
            started_at: NOW() - 7 * 3600,
            finished_at: null,
            notified: 0,
            content: JSON.stringify({ title: 'Perdu', description: '', url: null })
        };
        const repo = fakeRepo([target()], [credential()], [stale]);
        const { deps, sync, answers, beat } = syncByInstance(repo);
        answers.set('https://dokploy.exemple.fr', new Error('Instance Dokploy injoignable'));
        await beat();
        await sync.idle();
        assert.deepEqual(
            repo.deployments.map((d) => [
                d.status,
                d.notified,
                (JSON.parse(d.content) as { description: string }).description
            ]),
            [['failed', 1, 'Suivi perdu : l’instance ne répond plus.']]
        );
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });
});

describe('le blob d’un déploiement', () => {
    it('garde la description écrite au même tour que le premier message vivant', async () => {
        const startedAt = NOW() - 20;
        const local: DeploymentRow = {
            id: 5,
            target_id: 1,
            workspace_id: 1,
            external_id: null,
            status: 'queued',
            triggered_by_user_id: 3,
            started_at: startedAt,
            finished_at: null,
            notified: 0,
            content: JSON.stringify({ title: 'Mise en prod', description: '', url: null })
        };
        const repo = fakeRepo([target()], [credential()], [local]);
        const { tick, answer } = syncWith(repo, { liveChannels: [7] });
        answer({ remote: [entry({ externalId: 'dep-9', startedAt, description: 'Construction' })] });
        await tick();
        const blob = JSON.parse(repo.deployments[0].content) as { description: string; noticeIds: object };
        assert.equal(blob.description, 'Construction');
        assert.deepEqual(blob.noticeIds, { '7': 'live-1' });
    });
});

describe('le déploiement par une machine', () => {
    const DEVICE = '11111111-2222-4333-8444-555555555555';
    const machineTarget = () =>
        target({
            id: 1,
            credential_id: null,
            device_id: DEVICE,
            provider: 'agent',
            target_kind: 'service',
            external_id: 'docker/site/web',
            content: JSON.stringify({ name: 'Site' })
        });
    const queued = (): DeploymentRow => ({
        id: 5,
        target_id: 1,
        workspace_id: 1,
        external_id: 'op-5',
        status: 'queued',
        triggered_by_user_id: 3,
        started_at: NOW(),
        finished_at: null,
        notified: 0,
        content: JSON.stringify({ title: 'Mise en prod', description: '', url: null })
    });
    const job = (repo: FakeRepo) => ({
        target: repo.targets[0],
        deploymentId: 5,
        service: { engine: 'docker' as const, project: 'site', service: 'web' }
    });

    it('demande à l’agent de déployer le service, garde son journal, puis conclut le message et prévient', async () => {
        const repo = fakeRepo([machineTarget()], [], [queued()]);
        const orders: unknown[] = [];
        const deps = createTestServiceDeps({
            repo,
            liveChannels: [7],
            devices: [testDevice({ id: DEVICE, name: 'vps2' })],
            dockerRun: async (_deviceId, order, options) => {
                orders.push(order);
                options?.onLine?.('Pulling web');
                options?.onLine?.('Container site-web-1 Recreated');
                return { ok: true };
            }
        });
        const sync = new DeploySync(deps);
        sync.startAgentDeploy(job(repo));
        await sync.idle();

        assert.deepEqual(orders, [{ engine: 'docker', action: 'composeDeploy', target: 'site/web' }]);
        const [row] = repo.deployments;
        assert.equal(row.status, 'success');
        assert.equal(row.notified, 1);
        assert.equal((JSON.parse(row.content) as { log: string }).log, 'Pulling web\nContainer site-web-1 Recreated');
        // Ouvert en vol, conclu à l'atterrissage : le même message.
        assert.deepEqual(
            deps.recorded.liveMessages.map((m) => m.messageId),
            [null, 'live-1']
        );
        assert.deepEqual(
            deps.recorded.notifications.map((n) => [n.except, n.subject]),
            [[[7], '[DevEye] Succès du déploiement : Site']]
        );
    });

    it('dit pourquoi la machine a refusé', async () => {
        const repo = fakeRepo([machineTarget()], [], [queued()]);
        const deps = createTestServiceDeps({
            repo,
            dockerRun: async () => ({
                ok: false,
                error: 'refused by local policy (allow_docker_deploy = false in agent.toml)'
            })
        });
        const sync = new DeploySync(deps);
        sync.startAgentDeploy(job(repo));
        await sync.idle();

        const [row] = repo.deployments;
        assert.equal(row.status, 'failed');
        assert.match((JSON.parse(row.content) as { description: string }).description, /allow_docker_deploy/);
        assert.equal(deps.recorded.notifications.length, 1);
        assert.match(deps.recorded.notifications[0].body, /allow_docker_deploy/);
    });

    it('marque en échec, sans avis, ce qu’un redémarrage a interrompu', async () => {
        const repo = fakeRepo([machineTarget()], [], [{ ...queued(), status: 'running' }]);
        const deps = createTestServiceDeps({ repo });
        await new DeploySync(deps).recover();
        const [row] = repo.deployments;
        assert.equal(row.status, 'failed');
        assert.equal(row.notified, 1);
        assert.match((JSON.parse(row.content) as { description: string }).description, /redémarrage du serveur/);
        assert.equal(deps.recorded.notifications.length, 0);
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });
});
