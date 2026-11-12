import { taskAttach, taskCancel, taskDismiss } from '@deveye/types';

import { defineFeature, type FeatureDefinition } from '../_define';

export const taskAttachFeature: FeatureDefinition<
    typeof taskAttach.command,
    typeof taskAttach.input,
    typeof taskAttach.output
> = defineFeature({
    ...taskAttach,
    access: { scope: 'account' },
    // Hors socket, personne n'attend de réponse : tout est perdu.
    handler: async (ctx, input) => ({
        lost: ctx.tasks ? ctx.tasks.attach(input.claims) : input.claims.map((claim) => claim.id)
    })
});

export const taskDismissFeature: FeatureDefinition<
    typeof taskDismiss.command,
    typeof taskDismiss.input,
    typeof taskDismiss.output
> = defineFeature({
    ...taskDismiss,
    access: { scope: 'account' },
    handler: async (ctx, input) => ({ ids: ctx.tasks?.dismiss(input.ids) ?? [] })
});

export const taskCancelFeature: FeatureDefinition<
    typeof taskCancel.command,
    typeof taskCancel.input,
    typeof taskCancel.output
> = defineFeature({
    ...taskCancel,
    access: { scope: 'account' },
    handler: async (ctx, input) => ({ accepted: (await ctx.tasks?.cancel(input.id)) ?? false })
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const taskFeatures: FeatureDefinition<string, any, any>[] = [
    taskAttachFeature,
    taskDismissFeature,
    taskCancelFeature
];
