import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer } from '@deveye/types/sdk/server';

import { mailboxContentSchema, unseal } from './_shared';
import { createDomainHooks } from './domains';
import { mailserverHandlers } from './handlers';
import { createRepo, type MailserverRepo } from './repo';
import { createMailService } from './service';
import { MAILSERVER_ENV } from './env';

/**
 * Pas d'entrée `move` : une adresse vit sur un domaine de son espace, qui ne la
 * suivrait pas. L'absence est la réponse sûre, l'app ne propose alors pas le
 * déplacement.
 */
export const serverEntry: FeatureServer<MailserverRepo> = {
    env: MAILSERVER_ENV,
    createRepo,
    features: mailserverHandlers,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    createService: (deps) => createMailService(deps),
    domains: createDomainHooks(),
    quotas: {
        addresses: { list: (repo, owned) => repo.listInWorkspaces(owned) }
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisible(Number(itemId), workspaceId))?.workspace_id ?? null,
        async labelOf(repo, cipher, itemId, workspaceId) {
            const row = await repo.findVisible(Number(itemId), workspaceId);
            if (!row) return null;
            const content = await unseal(cipher, row.content, mailboxContentSchema, { displayName: '' });
            // L'adresse identifie mieux une boîte que son nom affiché, souvent vide.
            return content.displayName.length > 0 ? `${content.displayName} (${row.address})` : row.address;
        }
    }
};
