import { defineSdkFeature } from '@deveye/types/sdk/server';

import { invoicingCount } from '../../contracts/commands';
import { settingsOf, today, type Ctx } from '../_shared';
import { clientHandlers } from './clients';
import { copyHandlers } from './copy';
import { deriveHandlers } from './derive';
import { docHandlers } from './docs';
import { issueHandlers } from './issue';
import { paperHandlers } from './paper';
import { sendHandlers } from './send';
import { shareHandlers } from './share';
import { paymentHandlers } from './payments';
import { settingsHandlers } from './settings';

/**
 * La carte de l'accueil : ce qui reste à encaisser, sa part échue, les devis
 * acceptés qui attendent leur facture, et les brouillons. « Aujourd'hui » vient
 * du fuseau de l'espace et part en paramètre : un retard ne doit pas dépendre du
 * fuseau du serveur.
 */
const count = defineSdkFeature({
    ...invoicingCount,
    handler: async (ctx: Ctx) => {
        const settings = await settingsOf(ctx);
        const [outstanding, toBill, draftCount] = await Promise.all([
            ctx.repo.outstanding(ctx.workspaceId, today(settings)),
            ctx.repo.toBill(ctx.workspaceId),
            ctx.repo.countDrafts(ctx.workspaceId)
        ]);
        return {
            summary: {
                currency: settings.currency,
                ...outstanding,
                toBillCents: toBill.cents,
                toBillCount: toBill.count,
                draftCount
            }
        };
    }
});

export const invoicingHandlers = [
    count,
    ...settingsHandlers,
    ...clientHandlers,
    ...docHandlers,
    ...issueHandlers,
    ...paperHandlers,
    ...paymentHandlers,
    ...deriveHandlers,
    ...shareHandlers,
    ...sendHandlers,
    ...copyHandlers
];
