import { homeShortcutPreview } from '@deveye/types';
import { fetchShortcutPreview } from '@/Services/shortcutTemplates';
import { defineFeature, type FeatureDefinition } from '../_define';

export const homeShortcutPreviewFeature: FeatureDefinition<
    typeof homeShortcutPreview.command,
    typeof homeShortcutPreview.input,
    typeof homeShortcutPreview.output
> = defineFeature({
    ...homeShortcutPreview,
    // Réservée à qui touche à l'accueil : ouverte, elle laisserait n'importe
    // quel membre faire chercher une URL arbitraire par le serveur.
    access: { capabilities: ['workspace.layout'] },
    handler: async (_ctx, input) => {
        // Best-effort: the service never throws — a failed fetch returns an empty
        // (`ok: false`) preview so the shortcut tile still works as a plain link.
        return fetchShortcutPreview(input.template, input.url, input.refresh);
    }
});
