import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    deployAdd,
    deployCount,
    deployCredentialAdd,
    deployCredentialList,
    deployCredentialRemove,
    deployCredentialUpdate,
    deployGet,
    deployList,
    deployRemove,
    deployReorder,
    deployTrigger,
    deployUpdate
} from '../contracts/commands';
import type { DeployCredentialRow, DeploymentRow, DeployTargetRow } from '../contracts/domain';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider } from '@deveye/types/sdk';
import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { deployHandlers } from './handlers';
import type { DeployRepo, DeployTargetWithUsageRow } from './repo';

/**
 * Les handlers du module, sur le harnais du SDK : les restrictions par élément,
 * le partage inter-espaces (projection listée sous le codec de son domicile,
 * jamais modifiable depuis la fenêtre), le contrat de Projets (absent = zéro),
 * l'idempotence de la déclaration, le ménage à la suppression et les clés
 * Dokploy (secret jamais rendu, absent = conservé, retrait qui met les cibles à
 * NULL).
 */

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = deployHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<DeployRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

const failsWith =
    (code: FeatureError['code']) =>
    (e: unknown): boolean =>
        e instanceof FeatureError && e.code === code;

interface FakeRepo extends DeployRepo {
    targets: DeployTargetRow[];
    deployments: DeploymentRow[];
    credentials: DeployCredentialRow[];
}

/** Une cible en base, telle que le vrai dépôt la rendrait (contenu en clair : le harnais chiffre à l'identité). */
function target(over: Partial<DeployTargetRow> & { id: number; workspace_id: number }): DeployTargetRow {
    return {
        credential_id: 10,
        provider: 'dokploy',
        target_kind: 'application',
        external_id: `app-${over.id}`,
        sort_order: over.id,
        content: JSON.stringify({ name: `Cible ${over.id}` }),
        synced_at: null,
        created: 1,
        ...over
    };
}

function credential(over: Partial<DeployCredentialRow> & { id: number; workspace_id: number }): DeployCredentialRow {
    return {
        provider: 'dokploy',
        label: `Clé ${over.id}`,
        base_url: 'https://dokploy.exemple.fr',
        secret_enc: 'clé-secrète',
        created: 1,
        ...over
    };
}

function deployment(
    over: Partial<DeploymentRow> & { id: number; target_id: number; workspace_id: number }
): DeploymentRow {
    return {
        external_id: `dep-${over.id}`,
        status: 'success',
        triggered_by_user_id: null,
        started_at: 1_000,
        finished_at: 1_060,
        notified: 1,
        content: JSON.stringify({ title: `Déploiement ${over.id}`, description: '', url: null }),
        ...over
    };
}

/**
 * Un dépôt en mémoire, même contrat que le vrai. `projections` reproduit
 * `item_shares` (`targetId → espaces où elle est projetée`) ; le harnais
 * (`shares`) doit le dire en écho pour que `ctx.sharing.scope()` connaisse le
 * domicile.
 */
function fakeRepo(projections: Record<number, number[]> = {}): FakeRepo {
    let seq = 100;
    const targets: DeployTargetRow[] = [];
    const deployments: DeploymentRow[] = [];
    const credentials: DeployCredentialRow[] = [];
    const visible = (t: DeployTargetRow, workspaceId: number) =>
        t.workspace_id === workspaceId || (projections[t.id] ?? []).includes(workspaceId);
    const withUsage = (t: DeployTargetRow): DeployTargetWithUsageRow => {
        const last = deployments
            .filter((d) => d.target_id === t.id)
            .sort((a, b) => b.started_at - a.started_at || b.id - a.id)[0];
        return {
            ...t,
            base_url: credentials.find((c) => c.id === t.credential_id)?.base_url ?? null,
            last_status: last?.status ?? null,
            last_deploy_at: last?.started_at ?? null
        };
    };
    const unused = async () => {
        throw new Error('non attendu ici');
    };
    return {
        targets,
        deployments,
        credentials,
        listTargets: async (workspaceId) => targets.filter((t) => t.workspace_id === workspaceId).map(withUsage),
        listVisibleTargets: async (workspaceId) => targets.filter((t) => visible(t, workspaceId)).map(withUsage),
        findTarget: async (id, workspaceId) =>
            targets.find((t) => t.id === id && t.workspace_id === workspaceId) ?? null,
        findVisibleTarget: async (id, workspaceId) =>
            targets.find((t) => t.id === id && visible(t, workspaceId)) ?? null,
        findTargetWithUsage: async (id, workspaceId) => {
            const t = targets.find((x) => x.id === id && x.workspace_id === workspaceId);
            return t ? withUsage(t) : null;
        },
        findVisibleTargetWithUsage: async (id, workspaceId) => {
            const t = targets.find((x) => x.id === id && visible(x, workspaceId));
            return t ? withUsage(t) : null;
        },
        findTargetByExternal: async (workspaceId, credentialId, externalId) =>
            targets.find(
                (t) =>
                    t.workspace_id === workspaceId && t.credential_id === credentialId && t.external_id === externalId
            ) ?? null,
        countTargets: async (workspaceId) => targets.filter((t) => t.workspace_id === workspaceId).length,
        countTargetsInWorkspaces: async (ids) => targets.filter((t) => ids.includes(t.workspace_id)).length,
        async createTarget(input) {
            const created = target({
                id: ++seq,
                workspace_id: input.workspaceId,
                credential_id: input.credentialId,
                provider: input.provider,
                target_kind: input.kind,
                external_id: input.externalId,
                content: input.content
            });
            targets.push(created);
            return created;
        },
        async updateTarget(id, workspaceId, input) {
            const t = targets.find((x) => x.id === id && x.workspace_id === workspaceId);
            if (!t) return null;
            Object.assign(t, {
                credential_id: input.credentialId,
                target_kind: input.kind,
                external_id: input.externalId,
                content: input.content
            });
            return t;
        },
        async deleteTarget(id, workspaceId) {
            const i = targets.findIndex((t) => t.id === id && t.workspace_id === workspaceId);
            if (i === -1) return false;
            targets.splice(i, 1);
            return true;
        },
        async reorderTargets(workspaceId, ids) {
            ids.forEach((id, i) => {
                const t = targets.find((x) => x.id === id && x.workspace_id === workspaceId);
                if (t) t.sort_order = i;
            });
        },
        listCredentials: async (workspaceId) => credentials.filter((c) => c.workspace_id === workspaceId),
        findCredential: async (id, workspaceId) =>
            credentials.find((c) => c.id === id && c.workspace_id === workspaceId) ?? null,
        async createCredential(input) {
            const created = credential({
                id: ++seq,
                workspace_id: input.workspaceId,
                provider: input.provider,
                label: input.label,
                base_url: input.baseUrl,
                secret_enc: input.secretEnc
            });
            credentials.push(created);
            return created;
        },
        async updateCredential(id, workspaceId, input) {
            const c = credentials.find((x) => x.id === id && x.workspace_id === workspaceId);
            if (!c) return null;
            c.label = input.label;
            c.base_url = input.baseUrl;
            if (input.secretEnc !== undefined) c.secret_enc = input.secretEnc;
            return c;
        },
        async removeCredential(id, workspaceId) {
            // Comme le vrai dépôt : les cibles de la clé passent à NULL.
            for (const t of targets) {
                if (t.credential_id === id && t.workspace_id === workspaceId) t.credential_id = null;
            }
            const i = credentials.findIndex((c) => c.id === id && c.workspace_id === workspaceId);
            if (i === -1) return false;
            credentials.splice(i, 1);
            return true;
        },
        countCredentialUses: async (workspaceId) => {
            const uses = new Map<number, number>();
            for (const t of targets) {
                if (t.workspace_id !== workspaceId || t.credential_id === null) continue;
                uses.set(t.credential_id, (uses.get(t.credential_id) ?? 0) + 1);
            }
            return uses;
        },
        listTargetsDue: unused,
        markTargetSynced: unused,
        createDeployment: unused,
        createRemoteDeployment: unused,
        updateDeployment: unused,
        markDeploymentNotified: unused,
        setDeploymentContent: unused,
        listDeployments: async (targetId, workspaceId, limit) =>
            deployments
                .filter((d) => d.target_id === targetId && d.workspace_id === workspaceId)
                .sort((a, b) => b.started_at - a.started_at || b.id - a.id)
                .slice(0, limit)
    };
}

function seed(repo: FakeRepo, ...seeded: DeployTargetRow[]): FakeRepo {
    repo.targets.push(...seeded);
    return repo;
}

/** Le contrat de Projets, tel que l'app (ou son module) l'offre : l'espace 1 relie la cible 1 à deux projets. */
function projectsProvider(recorded: { projectId: number; kind: string; label: string }[] = []): ProjectsUsageProvider {
    return {
        usageOf: async (feature, itemId, workspaceId) =>
            feature === 'deploy' && itemId === 1 && workspaceId === 1
                ? [
                      { projectId: 5, title: 'Boutique', status: 'active' },
                      { projectId: 6, title: 'Sans titre', status: 'draft' }
                  ]
                : [],
        countByItem: async (feature, workspaceId) =>
            feature === 'deploy' && workspaceId === 1 ? new Map([[1, 2]]) : new Map(),
        detach: async () => 0,
        recordEvent: async (projectId, _workspaceId, event) => {
            recorded.push({ projectId, kind: event.kind, label: event.label });
        },
        // Une version ne se reporte que depuis un dépôt git : rien à faire ici.
        // Non sollicitées ici : l'écriture des liaisons est testée chez Projets.
        linkTargets: async () => [],
        link: async () => undefined,
        unlink: async () => undefined,
        applyVersion: async () => undefined
    };
}

describe('deploy.count et deploy.list', () => {
    it('retirent une cible masquée pour ce rôle, joignent l’adresse de la clé et comptent les projets par le contrat', async () => {
        const repo = seed(
            fakeRepo(),
            target({ id: 1, workspace_id: 1 }),
            target({ id: 2, workspace_id: 1, credential_id: null }),
            target({ id: 3, workspace_id: 1 })
        );
        repo.credentials.push(credential({ id: 10, workspace_id: 1 }));
        repo.deployments.push(deployment({ id: 50, target_id: 1, workspace_id: 1, status: 'failed' }));
        const ctx = createTestContext({
            repo,
            itemRestrictions: { 3: 'none' },
            providers: { [PROJECTS_USAGE_PROVIDER]: projectsProvider() }
        });

        const listed = await handlerFor(deployList)(ctx, {});
        assert.deepEqual(
            listed.targets.map((t) => [t.id, t.name, t.foreign, t.location, t.lastStatus, t.projectCount]),
            [
                [1, 'Cible 1', false, 'dokploy.exemple.fr', 'failed', 2],
                [2, 'Cible 2', false, null, null, 0]
            ]
        );
        // La carte compte ce que la liste montre, restrictions déduites.
        assert.deepEqual(await handlerFor(deployCount)(ctx, {}), { count: 2 });
    });

    it('sans contrat de Projets, le compte vaut zéro plutôt qu’une erreur', async () => {
        const repo = seed(fakeRepo(), target({ id: 1, workspace_id: 1 }));
        const listed = await handlerFor(deployList)(createTestContext({ repo }), {});
        assert.equal(listed.targets[0].projectCount, 0);
    });
});

describe('le partage inter-espaces', () => {
    it("liste une projection avec sa pastille `foreign`, sous le codec de son espace d'origine", async () => {
        // La cible 7 vit dans l'espace 42 et se projette vers l'espace 1.
        const repo = seed(fakeRepo({ 7: [1] }), target({ id: 7, workspace_id: 42 }));
        const ctx = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });

        // Le harnais chiffre à l'identité : c'est l'appel qui se vérifie.
        const asked: number[] = [];
        const scope = ctx.sharing.scope;
        ctx.sharing = {
            ...ctx.sharing,
            scope: async () => {
                const real = await scope();
                return {
                    ...real,
                    cipherFor: (itemId) => {
                        asked.push(Number(itemId));
                        return real.cipherFor(itemId);
                    }
                };
            }
        };
        const listed = await handlerFor(deployList)(ctx, {});
        assert.deepEqual(
            listed.targets.map((t) => [t.id, t.foreign]),
            [[7, true]]
        );
        assert.deepEqual(asked, [7]);
    });

    it('ouvre la fiche d’une projection avec l’historique de son domicile, et les projets d’ici', async () => {
        const repo = seed(fakeRepo({ 7: [1] }), target({ id: 7, workspace_id: 42 }));
        repo.deployments.push(deployment({ id: 70, target_id: 7, workspace_id: 42 }));
        const ctx = createTestContext({
            repo,
            workspaceId: 1,
            shares: { 7: 42 },
            providers: { [PROJECTS_USAGE_PROVIDER]: projectsProvider() }
        });

        const out = await handlerFor(deployGet)(ctx, { targetId: 7 });
        assert.equal(out.target.foreign, true);
        assert.deepEqual(
            out.deployments.map((d) => [d.id, d.title, d.status]),
            [[70, 'Déploiement 70', 'success']]
        );
        // Les projets listés sont ceux de l'espace APPELANT : aucun ici.
        assert.deepEqual(out.projectIds, []);
        assert.equal(out.target.projectCount, 0);
    });

    it('refuse de modifier une projection depuis la fenêtre', async () => {
        const repo = seed(fakeRepo({ 7: [1] }), target({ id: 7, workspace_id: 42 }));
        const ctx = createTestContext({ repo, workspaceId: 1, shares: { 7: 42 } });
        await assert.rejects(
            handlerFor(deployUpdate)(ctx, {
                targetId: 7,
                credentialId: null,
                kind: 'compose',
                externalId: 'app-7',
                name: 'Renommée'
            }),
            failsWith('forbidden')
        );
        assert.equal(repo.targets[0].target_kind, 'application');
        await assert.rejects(handlerFor(deployRemove)(ctx, { targetId: 7 }), failsWith('forbidden'));
        assert.equal(repo.targets.length, 1);
    });
});

describe('deploy.get', () => {
    it('rend la cible, son historique du plus récent au plus ancien, et les projets qui la déploient', async () => {
        const repo = seed(fakeRepo(), target({ id: 1, workspace_id: 1 }));
        repo.deployments.push(
            deployment({ id: 50, target_id: 1, workspace_id: 1, started_at: 1_000 }),
            deployment({
                id: 51,
                target_id: 1,
                workspace_id: 1,
                started_at: 2_000,
                status: 'running',
                finished_at: null
            })
        );
        const ctx = createTestContext({ repo, providers: { [PROJECTS_USAGE_PROVIDER]: projectsProvider() } });

        const out = await handlerFor(deployGet)(ctx, { targetId: 1 });
        assert.equal(out.target.name, 'Cible 1');
        assert.equal(out.target.projectCount, 2);
        assert.deepEqual(
            out.deployments.map((d) => [d.id, d.status, d.finishedAt]),
            [
                [51, 'running', null],
                [50, 'success', 1_060]
            ]
        );
        assert.deepEqual(out.projectIds, [5, 6]);
    });

    it('répond `not_found` pour une cible d’un autre espace non projetée', async () => {
        const repo = seed(fakeRepo(), target({ id: 7, workspace_id: 42 }));
        await assert.rejects(
            handlerFor(deployGet)(createTestContext({ repo, workspaceId: 1 }), { targetId: 7 }),
            failsWith('not_found')
        );
    });
});

describe('deploy.add', () => {
    const body = { credentialId: 10, kind: 'compose' as const, externalId: 'stack-1', name: 'Pile de prod' };

    it('refuse une clé inconnue de cet espace', async () => {
        const repo = fakeRepo();
        repo.credentials.push(credential({ id: 10, workspace_id: 42 }));
        await assert.rejects(handlerFor(deployAdd)(createTestContext({ repo }), body), failsWith('not_found'));
        assert.equal(repo.targets.length, 0);
    });

    it('déclare une cible chiffrée à l’étage ouvert, et la retrouve au lieu de la dupliquer', async () => {
        const repo = fakeRepo();
        repo.credentials.push(credential({ id: 10, workspace_id: 1 }));
        const ctx = createTestContext({ repo });

        const first = await handlerFor(deployAdd)(ctx, body);
        assert.equal(first.target.name, 'Pile de prod');
        assert.equal(first.target.kind, 'compose');
        assert.equal(first.target.location, 'dokploy.exemple.fr');
        assert.equal(first.target.projectCount, 0);
        // Le harnais chiffre à l'identité : le nom est dans le blob.
        assert.equal(repo.targets[0].content, JSON.stringify({ name: 'Pile de prod' }));
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['deploy.add']
        );

        // Idempotente sur (clé, identifiant externe).
        const again = await handlerFor(deployAdd)(ctx, { ...body, name: 'Pile renommée' });
        assert.equal(again.target.id, first.target.id);
        assert.equal(again.target.name, 'Pile renommée');
        assert.equal(repo.targets.length, 1);
        assert.equal(ctx.recorded.audits.length, 1);
    });

    it('borne les cibles de tous les espaces du propriétaire, sauf la redéclaration d’une cible existante', async () => {
        const repo = fakeRepo();
        repo.credentials.push(credential({ id: 10, workspace_id: 1 }));
        repo.targets.push(target({ id: 1, workspace_id: 9, external_id: 'ailleurs' }));
        const ctx = createTestContext({ repo, quotaLimits: { targets: 2 }, ownerWorkspaceIds: [1, 9] });

        await handlerFor(deployAdd)(ctx, body);
        await assert.rejects(
            handlerFor(deployAdd)(ctx, { ...body, externalId: 'stack-2' }),
            failsWith('quota_exceeded')
        );
        // La même cible, redéclarée : rien ne s'ajoute, rien ne bute.
        await handlerFor(deployAdd)(ctx, { ...body, name: 'Pile renommée' });
        assert.equal(repo.targets.length, 2);
    });
});

describe('deploy.update, deploy.remove et deploy.reorder', () => {
    it('modifie une cible chez elle', async () => {
        const repo = seed(fakeRepo(), target({ id: 1, workspace_id: 1 }));
        repo.credentials.push(credential({ id: 10, workspace_id: 1 }), credential({ id: 11, workspace_id: 1 }));
        const out = await handlerFor(deployUpdate)(createTestContext({ repo }), {
            targetId: 1,
            credentialId: 11,
            kind: 'compose',
            externalId: 'stack-1',
            name: 'Renommée'
        });
        assert.deepEqual(
            [out.target.credentialId, out.target.kind, out.target.externalId, out.target.name],
            [11, 'compose', 'stack-1', 'Renommée']
        );
    });

    it('supprimer fait le ménage des projections, restrictions et route', async () => {
        const repo = seed(fakeRepo(), target({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({ repo });
        assert.deepEqual(await handlerFor(deployRemove)(ctx, { targetId: 1 }), { targetId: 1 });
        assert.deepEqual(repo.targets, []);
        assert.deepEqual(ctx.forgotten, ['1']);
        assert.equal(ctx.recorded.audits[0].action, 'deploy.remove');

        await assert.rejects(handlerFor(deployRemove)(ctx, { targetId: 1 }), failsWith('not_found'));
    });

    it('range les cibles dans l’ordre donné', async () => {
        const repo = seed(fakeRepo(), target({ id: 1, workspace_id: 1 }), target({ id: 2, workspace_id: 1 }));
        assert.deepEqual(await handlerFor(deployReorder)(createTestContext({ repo }), { targetIds: [2, 1] }), {
            targetIds: [2, 1]
        });
        assert.deepEqual(
            repo.targets.map((t) => [t.id, t.sort_order]),
            [
                [1, 1],
                [2, 0]
            ]
        );
    });
});

describe('deploy.trigger', () => {
    it('refuse une cible dont la clé a été retirée, avant tout appel au fournisseur', async () => {
        const repo = seed(fakeRepo(), target({ id: 1, workspace_id: 1, credential_id: null }));
        const ctx = createTestContext({ repo });
        await assert.rejects(
            handlerFor(deployTrigger)(ctx, { targetId: 1, title: 'Mise en prod', description: '' }),
            failsWith('validation')
        );
        assert.deepEqual(repo.deployments, []);
        assert.deepEqual(ctx.recorded.audits, []);
    });
});

describe('les clés Dokploy', () => {
    it('liste les clés de l’espace avec leur usage, sans jamais rendre le secret', async () => {
        const repo = seed(fakeRepo(), target({ id: 1, workspace_id: 1 }), target({ id: 2, workspace_id: 1 }));
        repo.credentials.push(
            credential({ id: 10, workspace_id: 1 }),
            credential({ id: 11, workspace_id: 1, label: 'Sans usage' }),
            credential({ id: 12, workspace_id: 42 })
        );
        const out = await handlerFor(deployCredentialList)(createTestContext({ repo }), {});
        assert.deepEqual(
            out.credentials.map((c) => [c.id, c.label, c.baseUrl, c.hasSecret, c.useCount]),
            [
                [10, 'Clé 10', 'https://dokploy.exemple.fr', true, 2],
                [11, 'Sans usage', 'https://dokploy.exemple.fr', true, 0]
            ]
        );
        assert.ok(out.credentials.every((c) => !('secret' in c) && !('secretEnc' in c)));
    });

    it('ajoute une clé chiffrée à l’étage ouvert, audit `deploy.credentialAdd`', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo });
        const out = await handlerFor(deployCredentialAdd)(ctx, {
            provider: 'dokploy',
            label: 'Prod',
            baseUrl: 'https://dokploy.exemple.fr',
            secret: 'sk-1'
        });
        assert.equal(out.credential.label, 'Prod');
        assert.equal(out.credential.hasSecret, true);
        assert.equal(out.credential.useCount, 0);
        // Le harnais chiffre à l'identité : le secret est dans sa colonne.
        assert.equal(repo.credentials[0].secret_enc, 'sk-1');
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['deploy.credentialAdd']
        );
    });

    it('un secret absent est conservé, un secret donné remplace l’ancien', async () => {
        const repo = seed(fakeRepo(), target({ id: 1, workspace_id: 1 }));
        repo.credentials.push(credential({ id: 10, workspace_id: 1 }));
        const ctx = createTestContext({ repo });
        const update = handlerFor(deployCredentialUpdate);

        const kept = await update(ctx, { credentialId: 10, label: 'Renommée', baseUrl: 'https://autre.exemple.fr' });
        assert.deepEqual(
            [kept.credential.label, kept.credential.baseUrl, kept.credential.useCount],
            ['Renommée', 'https://autre.exemple.fr', 1]
        );
        assert.equal(repo.credentials[0].secret_enc, 'clé-secrète');

        await update(ctx, { credentialId: 10, label: 'Renommée', baseUrl: 'https://autre.exemple.fr', secret: 'sk-2' });
        assert.equal(repo.credentials[0].secret_enc, 'sk-2');

        await assert.rejects(
            update(ctx, { credentialId: 99, label: 'x', baseUrl: 'https://x' }),
            failsWith('not_found')
        );
    });

    it('retirer une clé laisse ses cibles, sans clé, et répond `not_found` sur la clé d’un autre espace', async () => {
        const repo = seed(
            fakeRepo(),
            target({ id: 1, workspace_id: 1 }),
            target({ id: 2, workspace_id: 1, credential_id: 11 }),
            target({ id: 3, workspace_id: 42, credential_id: 10 })
        );
        repo.credentials.push(
            credential({ id: 10, workspace_id: 1 }),
            credential({ id: 11, workspace_id: 1 }),
            credential({ id: 10, workspace_id: 42 })
        );
        const ctx = createTestContext({ repo });

        assert.deepEqual(await handlerFor(deployCredentialRemove)(ctx, { credentialId: 10 }), { credentialId: 10 });
        // La cible de la clé passe à NULL, les autres gardent la leur, et
        // l'espace voisin n'est pas touché.
        assert.deepEqual(
            repo.targets.map((t) => [t.id, t.credential_id]),
            [
                [1, null],
                [2, 11],
                [3, 10]
            ]
        );
        assert.deepEqual(
            repo.credentials.map((c) => [c.id, c.workspace_id]),
            [
                [11, 1],
                [10, 42]
            ]
        );
        assert.equal(ctx.recorded.audits[0].action, 'deploy.credentialRemove');

        await assert.rejects(handlerFor(deployCredentialRemove)(ctx, { credentialId: 12 }), failsWith('not_found'));
    });
});
