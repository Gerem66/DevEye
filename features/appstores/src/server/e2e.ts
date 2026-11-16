import type { FeatureE2eEntry, SdkE2eContext } from '@deveye/types/sdk/server';

import type { AppStoresApp, AppStoresAppSummary, AppStoresSource } from '../contracts/domain';
import type { AppStoresRepo } from './repo';

/**
 * Les parcours de Stores, sans réseau : la vraie synchronisation demande de
 * vraies clés d'Apple et de Google, et se vérifie à la main. Ici, une app sans
 * store de bout en bout, sa liaison à un projet, et le refus d'une clé mal
 * formée avant tout appel.
 */

type Ctx = SdkE2eContext<AppStoresRepo>;

const NO_PROJECTS = 'Le module Projets n’est pas installé : rien à relier.';

const PROJECT_DRAFT = {
    title: 'Essai Stores',
    icon: '',
    description: '',
    tags: [],
    status: 'active',
    showOverview: false,
    showTimeline: true,
    timelineZoom: 'month',
    startDate: null,
    dueDate: null
};

const appOf = (ctx: Ctx) => ctx.state.get('app') as AppStoresApp;

function codeOf(e: unknown): string | undefined {
    return (e as { code?: string }).code;
}

async function addApp(ctx: Ctx, name: string, opts?: { workspaceId: number }): Promise<AppStoresApp> {
    const { app } = await ctx.send<{ app: AppStoresApp }>(
        'appstores.add',
        { name, ratingCountry: 'FR', apple: null, google: null },
        opts
    );
    ctx.defer(`Supprimer « ${name} »`, async () => {
        try {
            await ctx.send('appstores.remove', { appId: app.id }, opts);
        } catch (e) {
            if (codeOf(e) !== 'not_found') throw e;
        }
    });
    return app;
}

/** Attend un refus `validation` : la commande ne doit pas aboutir, ni partir chez un store. */
async function refused(ctx: Ctx, input: unknown, what: string): Promise<void> {
    try {
        await ctx.send('appstores.addSource', input);
    } catch (e) {
        if (codeOf(e) === 'validation') return;
        throw e;
    }
    throw new Error(`${what} a été accepté`);
}

/** Le projet et l'espace d'essai du scénario `projects`, `null` quand Projets manque. */
function linkTarget(ctx: Ctx): { projectId: number; opts: { workspaceId: number } } | null {
    const projectId = ctx.state.get('project') as number | undefined;
    if (projectId === undefined) return null;
    return { projectId, opts: { workspaceId: ctx.state.get('ws') as number } };
}

async function linkedFromSettings(ctx: Ctx, projectId: number, workspaceId: number): Promise<boolean> {
    const state = await ctx.send<{
        groups: { workspaceId: number; projects: { projectId: number; linked: boolean }[] }[];
    }>('links.projectsGet', { feature: 'appstores', itemId: String(appOf(ctx).id) }, { workspaceId });
    const target = state.groups
        .find((g) => g.workspaceId === workspaceId)
        ?.projects.find((p) => p.projectId === projectId);
    if (!target) throw new Error('Les réglages de l’app ne proposent pas le projet');
    return target.linked;
}

async function linkCount(ctx: Ctx, projectId: number, opts: { workspaceId: number }): Promise<number> {
    const { counts } = await ctx.send<{ counts: { appstores: number } }>('projects.linkCounts', { projectId }, opts);
    return counts.appstores;
}

export const appStoresE2e: FeatureE2eEntry<AppStoresRepo> = {
    scenarios: [
        {
            id: 'apps',
            label: 'Créer une app sans store, la renommer, la supprimer',
            steps: [
                {
                    label: 'Créer une app qui n’est sur aucun store',
                    run: async (ctx) => {
                        const app = await addApp(ctx, 'Essai de bout en bout');
                        ctx.state.set('app', app);
                        if (app.listings.length !== 0) throw new Error('L’app a reçu une fiche de store');
                        return `App ${app.id}`;
                    }
                },
                {
                    label: 'La renommer, et la voir renommée dans la liste',
                    run: async (ctx) => {
                        await ctx.send('appstores.update', {
                            appId: appOf(ctx).id,
                            name: 'Essai renommé',
                            ratingCountry: 'BE',
                            apple: null,
                            google: null
                        });
                        const { apps } = await ctx.send<{ apps: AppStoresAppSummary[] }>('appstores.list', {});
                        const found = apps.find((a) => a.app.id === appOf(ctx).id);
                        if (found?.app.name !== 'Essai renommé' || found.app.ratingCountry !== 'BE') {
                            throw new Error('La liste ne montre pas l’app renommée');
                        }
                        if (found.downloads !== null)
                            throw new Error('Une app sans store ne compte aucun téléchargement');
                    }
                },
                {
                    label: 'La supprimer',
                    run: async (ctx) => {
                        await ctx.send('appstores.remove', { appId: appOf(ctx).id });
                        try {
                            await ctx.send('appstores.get', { appId: appOf(ctx).id });
                        } catch (e) {
                            if (codeOf(e) === 'not_found') return;
                            throw e;
                        }
                        throw new Error('L’app supprimée se lit encore');
                    }
                }
            ]
        },
        {
            id: 'projects',
            label: 'Relier une app à un projet',
            steps: [
                {
                    label: 'Une app et un projet, dans un espace d’essai',
                    run: async (ctx) => {
                        const { workspace } = await ctx.send<{ workspace: { id: number } }>('workspace.add', {
                            name: 'Essai Stores et projet'
                        });
                        ctx.state.set('ws', workspace.id);
                        ctx.defer('Supprimer l’espace d’essai', async () => {
                            await ctx.send('workspace.delete', { workspaceId: workspace.id });
                        });
                        const opts = { workspaceId: workspace.id };
                        ctx.state.set('app', await addApp(ctx, 'Essai relié', opts));
                        try {
                            const { project } = await ctx.send<{ project: { id: number } }>(
                                'projects.add',
                                { project: PROJECT_DRAFT, securityTier: 'open' },
                                opts
                            );
                            ctx.state.set('project', project.id);
                        } catch (e) {
                            if (!String((e as Error).message).startsWith('Unknown command')) throw e;
                            return NO_PROJECTS;
                        }
                    }
                },
                {
                    label: 'La relier depuis l’onglet du projet',
                    run: async (ctx) => {
                        const target = linkTarget(ctx);
                        if (target === null) return NO_PROJECTS;
                        const { projectId, opts } = target;
                        await ctx.send('projects.appstoresLink', { projectId, appId: appOf(ctx).id }, opts);
                        const { labels } = await ctx.send<{ appIds: number[]; labels: { label: string | null }[] }>(
                            'projects.appstoresList',
                            { projectId },
                            opts
                        );
                        if (labels.length !== 1 || labels[0].label !== 'Essai relié') {
                            throw new Error('Le projet ne nomme pas l’app reliée');
                        }
                        if ((await linkCount(ctx, projectId, opts)) !== 1) {
                            throw new Error('L’onglet Stores du projet ne compte pas l’app');
                        }
                        const { app } = await ctx.send<{ app: AppStoresApp }>(
                            'appstores.get',
                            { appId: appOf(ctx).id },
                            opts
                        );
                        if (app.projectCount !== 1) throw new Error('L’app ne compte pas le projet qui la relie');
                    }
                },
                {
                    label: 'La retirer puis la remettre depuis les réglages de l’app',
                    run: async (ctx) => {
                        const target = linkTarget(ctx);
                        if (target === null) return NO_PROJECTS;
                        const { projectId, opts } = target;
                        if (!(await linkedFromSettings(ctx, projectId, opts.workspaceId))) {
                            throw new Error('Les réglages de l’app ne voient pas la liaison');
                        }
                        const base = {
                            feature: 'appstores',
                            itemId: String(appOf(ctx).id),
                            workspaceId: opts.workspaceId,
                            projectId
                        };
                        await ctx.send('links.projectsSet', { ...base, linked: false }, opts);
                        if (await linkedFromSettings(ctx, projectId, opts.workspaceId)) {
                            throw new Error('La liaison n’a pas été retirée');
                        }
                        await ctx.send('links.projectsSet', { ...base, linked: true }, opts);
                        if (!(await linkedFromSettings(ctx, projectId, opts.workspaceId))) {
                            throw new Error('La liaison n’a pas été remise');
                        }
                    }
                },
                {
                    label: 'Supprimer l’app retire la liaison',
                    run: async (ctx) => {
                        const target = linkTarget(ctx);
                        if (target === null) return NO_PROJECTS;
                        const { projectId, opts } = target;
                        await ctx.send('appstores.remove', { appId: appOf(ctx).id }, opts);
                        if ((await linkCount(ctx, projectId, opts)) !== 0) {
                            throw new Error('Le projet relie encore l’app supprimée');
                        }
                    }
                }
            ]
        },
        {
            id: 'sources',
            label: 'Refuser une clé mal formée sans appeler les stores',
            steps: [
                {
                    label: 'Refuser un .p8 qui n’est pas une clé',
                    run: async (ctx) => {
                        await refused(
                            ctx,
                            {
                                store: 'apple',
                                label: 'Essai',
                                issuerId: '00000000-0000-0000-0000-000000000000',
                                keyId: 'ABCDE12345',
                                vendorNumber: '12345678',
                                privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'
                            },
                            'Un .p8 mal formé'
                        );
                    }
                },
                {
                    label: 'Refuser le JSON incomplet d’un compte de service',
                    run: async (ctx) => {
                        await refused(
                            ctx,
                            {
                                store: 'google',
                                label: 'Essai',
                                bucket: 'pubsite_prod_rev_01234567890123456789',
                                serviceAccount: JSON.stringify({
                                    type: 'service_account',
                                    client_email: 'essai@exemple.iam.gserviceaccount.com'
                                })
                            },
                            'Un JSON sans clé privée'
                        );
                    }
                },
                {
                    label: 'Ne rien avoir enregistré',
                    run: async (ctx) => {
                        const { sources } = await ctx.send<{ sources: AppStoresSource[] }>('appstores.listSources', {});
                        if (sources.length !== 0) throw new Error('Une source refusée a été enregistrée');
                    }
                }
            ]
        }
    ]
};
