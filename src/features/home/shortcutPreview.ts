import { homeShortcutPreview } from 'deveye-types';
import { fetchShortcutPreview } from '@/Services/shortcutTemplates';
import { defineFeature, type FeatureDefinition } from '../_define';

export const homeShortcutPreviewFeature: FeatureDefinition<
    typeof homeShortcutPreview.command,
    typeof homeShortcutPreview.input,
    typeof homeShortcutPreview.output
> = defineFeature({
    ...homeShortcutPreview,
    handler: async (_ctx, input) => {
        // Best-effort: the service never throws — a failed fetch returns an empty
        // (`ok: false`) preview so the shortcut tile still works as a plain link.
        return fetchShortcutPreview(input.template, input.url, input.refresh);
    }
});
