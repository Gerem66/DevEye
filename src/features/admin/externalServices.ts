import { adminExternalServices } from '@deveye/types';

import { admission } from '@/Services/admission';
import { externalServices } from '@/Services/externalServices';
import { defineFeature, type FeatureDefinition } from '../_define';

export const adminExternalServicesFeature: FeatureDefinition<
    typeof adminExternalServices.command,
    typeof adminExternalServices.input,
    typeof adminExternalServices.output
> = defineFeature({
    ...adminExternalServices,
    access: { admin: true, scope: 'account' },
    handler: async (ctx, input) => {
        const { at, services } = await externalServices(ctx.db, input.refresh);
        const caps = admission.settings();
        const { present, waiting } = admission.stats();
        return {
            services,
            seats: {
                free: { cap: caps.free, present: present.free, waiting: waiting.free },
                paid: { cap: caps.paid, present: present.paid, waiting: waiting.paid }
            },
            checkedAt: at
        };
    }
});
