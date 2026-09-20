import {
    featureDescriptor,
    PROJECT_LINKED_FEATURES,
    projectLinksGet,
    projectLinksSet,
    type FeatureId,
    type ItemProjectGroup,
    type ItemProjectsState
} from '@deveye/types';

import { defineFeature, FeatureError, type FeatureContext } from '../_define';
import { featureAccessIn, resolveItemHome, usageProvider } from './_shared';

/**
 * Quels projets utilisent cet élément, et l'y attacher ou l'en retirer depuis
 * ses propres réglages. Natif et non module : un projet vit dans un espace,
 * l'élément est visible dans plusieurs, et le contexte d'un module ne sort
 * jamais de l'espace actif. Les liaisons restent celles de Projets ; rien ici
 * ne touche ses tables, tout passe par son contrat d'usage.
 *
 * L'autorisation est en tête de handler (fichier dans `ACCESS_EXEMPT`) : la
 * fonctionnalité visée est une donnée d'entrée, et le droit qui tranche
 * (`projects`) est celui de l'espace du PROJET, pas de l'actif.
 */

function isProjectLinkable(feature: FeatureId): boolean {
    return (PROJECT_LINKED_FEATURES as readonly FeatureId[]).includes(feature);
}

/** L'état complet, relu après chaque écriture plutôt que reconstruit. */
async function projectsState(ctx: FeatureContext, feature: FeatureId, itemId: string): Promise<ItemProjectsState> {
    const projects = usageProvider();
    if (!projects) return { groups: [], blocker: 'module' };
    const numeric = Number(itemId);
    // Les tables de liaison sont à clé numérique : une feature dont les
    // éléments sont des textes ne s'y range pas.
    if (!isProjectLinkable(feature) || !Number.isInteger(numeric)) return { groups: [], blocker: 'feature' };

    const home = await resolveItemHome(ctx, feature, itemId);
    const shares = await ctx.db.itemSharing.sharesOf(feature, itemId, home).catch(() => []);
    const visible = new Set([home, ...shares.map((s) => s.workspace_id)]);
    // Les espaces de l'appelant, et eux seuls : la même frontière que le partage.
    const mine = await ctx.db.workspaces.findAccessibleByUser(ctx.userId);

    const groups: ItemProjectGroup[] = [];
    for (const w of mine) {
        if (!visible.has(w.id)) continue;
        // Lire les titres des projets d'un espace exige d'y lire Projets ; sans
        // ce droit l'espace n'apparaît pas du tout, plutôt que vide et menteur.
        const { access } = await featureAccessIn(ctx, w.id, 'projects');
        if (access === null) continue;
        groups.push({
            workspaceId: w.id,
            workspaceName: w.name,
            isActive: w.id === ctx.workspaceId,
            isHome: w.id === home,
            writable: access === 'write',
            projects: [...(await projects.linkTargets(feature, numeric, w.id))]
        });
    }
    // L'espace actif en tête : c'est là qu'on règle, le reste est du contexte.
    groups.sort((a, b) => Number(b.isActive) - Number(a.isActive));
    return { groups, blocker: null };
}

const getFeature = defineFeature({
    ...projectLinksGet,
    handler: async (ctx, input) => {
        ctx.assertFeature(input.feature, 'read');
        // L'accès à l'élément lui-même, restrictions comprises : à qui il est
        // masqué, on ne dit pas non plus qui l'utilise.
        await ctx.assertItem(input.feature, input.itemId);
        return projectsState(ctx, input.feature, input.itemId);
    }
});

const setFeature = defineFeature({
    ...projectLinksSet,
    // Le sujet de l'espace actif ; celui du projet est battu par Projets
    // lui-même, seul à savoir dans quel espace il vient d'écrire.
    mutates: ['projects'],
    handler: async (ctx, input) => {
        // Voir l'élément suffit : le relier ne le modifie pas, c'est le PROJET
        // qui change, et `projects: write` là-bas l'autorise.
        ctx.assertFeature(input.feature, 'read');
        await ctx.assertItem(input.feature, input.itemId);

        const projects = usageProvider();
        if (!projects) throw new FeatureError('validation', 'Le module Projets n’est pas installé.');

        // L'état complet plutôt qu'une garde par garde : il dit déjà où
        // l'élément est visible, quels projets s'y relient et ce que l'appelant
        // peut toucher. Une seule vérité pour l'écran et pour la garde.
        const before = await projectsState(ctx, input.feature, input.itemId);
        const group = before.groups.find((g) => g.workspaceId === input.workspaceId);
        if (!group) throw new FeatureError('not_found', 'Cet espace ne voit pas cet élément.');
        const target = group.projects.find((p) => p.projectId === input.projectId);
        if (!target) throw new FeatureError('not_found', 'Projet introuvable dans cet espace.');
        if (!group.writable) {
            throw new FeatureError('forbidden', 'Vous ne modifiez pas les projets de cet espace.');
        }
        if (input.linked && target.archived) {
            throw new FeatureError('validation', 'Un projet archivé ne prend pas de nouvelle liaison.');
        }

        const numeric = Number(input.itemId);
        if (input.linked) await projects.link(input.feature, numeric, input.workspaceId, input.projectId);
        else await projects.unlink(input.feature, numeric, input.workspaceId, input.projectId);

        ctx.audit({
            action: 'links.projectsSet',
            description:
                `${featureDescriptor(input.feature).label} #${input.itemId} ` +
                `${input.linked ? 'relié au' : 'retiré du'} projet « ${target.title} » ` +
                `(espace « ${group.workspaceName} »)`
        });
        return projectsState(ctx, input.feature, input.itemId);
    }
});

export const projectLinkFeatures = [getFeature, setFeature];
