import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider, type ProjectUsage } from '@deveye/types/sdk';

import type { Database } from '@/db';
import type { ProjectUsageRow } from '@/db/repos/projectLinks';
import type Encryption from '@/Services/Encryption';
import { createOpenCipher, type Cipher } from '@/Services/SecureStore';
import { tryDecryptProject } from './_shared';

/**
 * Ce que les modules demandent à Projets (`PROJECTS_USAGE_PROVIDER`), offert
 * par l'app tant que la feature est native : pour un élément d'une autre
 * feature (une base de données aujourd'hui), les projets de l'espace qui le
 * relient, avec leur titre, et combien en relient chacun. C'est ce qui rend
 * l'interconnexion cliquable dans les deux sens sans qu'un module lise une
 * table de Projets.
 *
 * Le jour où Projets migre en module, son service publie la même clé et ce
 * fichier disparaît : les modules qui le lisent n'y verront aucune différence.
 */
export { PROJECTS_USAGE_PROVIDER };

interface Deps {
    db: Database;
    crypt: Encryption;
}

/**
 * Une table de liaison par feature reliée, explicite plutôt que dynamique :
 * chaque feature range ses liaisons dans sa propre table de Projets, et une
 * résolution par nom construirait une requête à partir d'une entrée. Une
 * feature absente d'ici ne relie rien : vide, jamais une erreur. Git,
 * Déploiement, Audience et Uptime s'y ajouteront à leur migration.
 */
const LINKS: Record<
    string,
    {
        usage(db: Database, itemId: number, workspaceId: number): Promise<ProjectUsageRow[]>;
        counts(db: Database, workspaceId: number): Promise<Map<number, number>>;
    }
> = {
    database: {
        usage: (db, itemId, workspaceId) => db.projectLinks.listDatabaseUsage(itemId, workspaceId),
        counts: (db, workspaceId) => db.projectLinks.countDatabaseLinks(workspaceId)
    }
};

export function createProjectsUsageProvider(deps: Deps): ProjectsUsageProvider {
    // Même mémoïsation par espace que les services de fond : le codec ouvert
    // résout la clé de l'espace une fois, pas à chaque projet listé.
    const ciphers = new Map<number, Cipher>();
    const cipherFor = (workspaceId: number): Cipher => {
        let cipher = ciphers.get(workspaceId);
        if (!cipher) {
            cipher = createOpenCipher(deps.db, deps.crypt, workspaceId);
            ciphers.set(workspaceId, cipher);
        }
        return cipher;
    };

    return {
        async usageOf(feature, itemId, workspaceId) {
            const link = LINKS[feature];
            if (!link) return [];
            const rows = await link.usage(deps.db, itemId, workspaceId);
            const cipher = cipherFor(workspaceId);
            // Tous à l'étage ouvert (la requête le garantit), donc lisibles
            // sans session ; un corps illisible garde le projet dans la liste,
            // sous un titre de secours.
            return Promise.all(
                rows.map(async (row): Promise<ProjectUsage> => ({
                    projectId: row.project_id,
                    title: (await tryDecryptProject(cipher, row.content))?.title || 'Sans titre',
                    status: row.status
                }))
            );
        },
        async countByItem(feature, workspaceId) {
            const link = LINKS[feature];
            if (!link) return new Map<number, number>();
            return link.counts(deps.db, workspaceId);
        }
    };
}
