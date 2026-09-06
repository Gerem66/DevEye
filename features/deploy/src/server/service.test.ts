import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeployCredentialRow, DeploymentRow, DeployTargetRow } from '../contracts/domain';
import { DEPLOY_ITEMS_PROVIDER, type DeployItemsProvider } from '@deveye/types/sdk';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import type { DokployDeployment, DokployTarget } from './dokploy';
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
        label: 'Prod',
        base_url: 'https://dokploy.exemple.fr',
        secret_enc: 'clé',
        created: 1,
        ...over
    };
}

function entry(over: Partial<DokployDeployment> = {}): DokployDeployment {
    return {
        externalId: 'dep-1',
        status: 'running',
        title: 'feat: mise en prod',
        description: '',
        startedAt: NOW() - 30,
        finishedAt: null,
        logPath: '/logs/dep-1',
        ...over
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
        // La requête du vrai dépôt, en mémoire : jointure sur la clé, compte des
        // déploiements en vol, les deux régimes et l'ordre.
        listTargetsDue: async (limit, staleBefore) =>
            targets
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
                .sort((a, b) => b.in_flight - a.in_flight || a.id - b.id)
                .slice(0, limit),
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
                .map((d) => ({ ...d }))
    };
}

/** Ce que l'instance factice répond : l'historique de la cible, son catalogue, la queue d'un journal, le dépôt. */
interface Answers {
    remote: DokployDeployment[];
    catalog?: DokployTarget[];
    log?: string;
    repoUrl?: string | null;
}

/** Le service sur le harnais, avec une instance Dokploy pilotée par le test. */
function syncWith(repo: FakeRepo, options: { liveChannels?: readonly number[]; notifyAccepted?: boolean } = {}) {
    const deps = createTestServiceDeps({ repo, ...options });
    let answers: Answers | null = { remote: [] };
    /** Lectures de la fiche d'une cible : une par cible et par heure, pas une par tour. */
    let repoReads = 0;
    const sync = new DeploySync(deps, {
        listDeployments: async () => {
            if (!answers) throw new Error('Instance Dokploy injoignable');
            return answers.remote;
        },
        listTargets: async () => answers?.catalog ?? [],
        fetchDeploymentLog: async () => answers?.log ?? '',
        fetchRepoUrl: async () => {
            repoReads += 1;
            if (!answers) throw new Error('Instance Dokploy injoignable');
            return answers.repoUrl ?? null;
        }
    });
    return {
        deps,
        sync,
        repoReads: () => repoReads,
        tick: () => deps.recorded.tickers[0].tick(),
        /** Ce que l'instance répond au prochain tour ; `null` = injoignable. */
        answer(next: Answers | null) {
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
            [[1, [7], '[DevEye] Succès du déploiement — Serveur']]
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
            [[[7], '[DevEye] Échec du déploiement — Serveur', true]]
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
