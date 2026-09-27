import { debugMailCatalog, debugMailPreview, debugMailSend } from '@deveye/types';

import { debugHost } from '@/Services/debug';
import { defineFeature } from '../_define';
import { ADMIN } from './access';

export const debugMailCatalogFeature = defineFeature({
    ...debugMailCatalog,
    access: ADMIN,
    handler: async (ctx) => debugHost().mail.catalog(ctx.userId)
});

export const debugMailPreviewFeature = defineFeature({
    ...debugMailPreview,
    access: ADMIN,
    handler: async (_ctx, input) => debugHost().mail.preview(input.key)
});

export const debugMailSendFeature = defineFeature({
    ...debugMailSend,
    access: ADMIN,
    handler: async (ctx, input) => {
        const { captured } = await debugHost().mail.send(ctx.userId, input.key, input.to, input.sender);
        ctx.audit({
            action: 'debug.mailSend',
            level: 'info',
            description: `Mail d’essai « ${input.key} » envoyé à ${input.to}`,
            metadata: { key: input.key, to: input.to, sender: input.sender.kind }
        });
        return { sentTo: input.to, captured };
    }
});
