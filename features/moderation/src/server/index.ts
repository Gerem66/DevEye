import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer } from '@deveye/types/sdk/server';

import { hitContext, now } from './_shared';
import { moderationAccountExport } from './accountExport';
import { moderationE2e } from './e2e';
import { MODERATION_ENV } from './env';
import { moderationExternalServices } from './externalServices';
import { moderationHandlers } from './handlers';
import { createRepo, type ModerationRepo } from './repo';
import { createModerationService } from './service';

/** L'entrée serveur du module : les commandes de modération, le service qui offre le provider, et ses tables. */
export const serverEntry: FeatureServer<ModerationRepo> = {
    env: MODERATION_ENV,
    createRepo,
    features: moderationHandlers,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    createService: (deps) => createModerationService(deps),
    accountExport: moderationAccountExport,
    externalServices: moderationExternalServices,
    e2e: moderationE2e,
    async adminFacts({ repo }) {
        const [manual, takedown, feed, recent] = await Promise.all([
            repo.countBySource('manual'),
            repo.countBySource('takedown'),
            repo.countBySource('feed'),
            repo.countHitsSince(now() - 30 * 24 * 3_600)
        ]);
        return [
            { label: 'Règles saisies', value: manual, unit: 'count' },
            { label: 'Empreintes de retraits', value: takedown, unit: 'count' },
            { label: 'Empreintes de la liste externe', value: feed, unit: 'count' },
            { label: 'Détections sur 30 jours', value: recent, unit: 'count' }
        ];
    },
    // Le nom du fichier et l'élément d'une détection : une rotation de la clé serveur les ré-emballe.
    sealed: [
        { table: 'ft_moderation_hits', column: 'content', id: 'dedupe_key', context: (key) => hitContext(String(key)) }
    ]
};
