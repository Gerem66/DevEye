import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer } from '@deveye/types/sdk/server';

import { invoicingClientInputSchema } from '../contracts/domain';
import { createDomainHooks } from './domains';
import { invoicingHandlers } from './handlers';
import { issuedThisMonth, QUOTA_KEYS } from './planUsage';
import { createRepo, type InvoicingRepo } from './repo';
import { createService } from './service';
import { invoicingMailSamples } from './documentMail';
import { invoicingAccountExport } from './accountExport';

const nameSchema = invoicingClientInputSchema.pick({ name: true });

export const serverEntry: FeatureServer<InvoicingRepo> = {
    createRepo,
    features: invoicingHandlers,
    accountExport: invoicingAccountExport,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    createService,
    mailSamples: invoicingMailSamples,
    domains: createDomainHooks(),
    quotas: {
        [QUOTA_KEYS.quote]: { count: issuedThisMonth('quote') },
        [QUOTA_KEYS.invoice]: { count: issuedThisMonth('invoice') }
    },
    /**
     * Fourni bien que rien ne soit partageable : sans lui, l'écran des canaux
     * de notification ne saurait pas nommer le client qu'une route vise, et
     * afficherait « cible disparue ».
     */
    items: {
        async homeOf(repo, itemId, workspaceId) {
            const row = await repo.findClient(Number(itemId), workspaceId);
            return row === null ? null : workspaceId;
        },
        async labelOf(repo, cipher, itemId, workspaceId) {
            const row = await repo.findClient(Number(itemId), workspaceId);
            if (row === null) return null;
            const plain = await cipher.tryDecrypt(row.content);
            if (plain === null) return null;
            const parsed = nameSchema.safeParse(JSON.parse(plain));
            if (!parsed.success || parsed.data.name.length === 0) return null;
            return parsed.data.name;
        }
    }
};
