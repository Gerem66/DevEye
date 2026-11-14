import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { CveRepo } from './repo';
import { NVD_KEY_STORE_KEY } from './_shared';

export const cveAccountExport: FeatureAccountExport<CveRepo> = {
    tables: {
        ft_cve_favorites: {
            file: 'epingles.json',
            where: 'workspace_id = ?',
            key: ['created', 'cve_id'],
            dates: { created: 's' }
        },
        ft_cve_entries: { skip: 'Le catalogue des vulnérabilités est public et commun à tous les comptes.' },
        ft_cve_state: { skip: 'L’avancée de la lecture du catalogue appartient au serveur.' },
        ft_cve_products: { skip: 'Les produits touchés par chaque vulnérabilité : une partie du catalogue public.' },
        ft_cve_watched: { skip: 'Les produits dont le serveur garde l’historique : un réglage du catalogue commun.' },
        ft_cve_assets: {
            file: 'elements-suivis.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['error_enc', 'summary_enc', 'inventory_enc'],
            json: ['summary_enc', 'inventory_enc'],
            dates: { checked_at: 's', scanned_at: 's', created: 's' }
        },
        ft_cve_asset_keys: {
            skip: 'Les empreintes des produits de chaque élément suivi : un index, rien de lisible.'
        },
        ft_cve_findings: {
            file: 'constats.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content_enc', 'reason_enc'],
            json: ['content_enc'],
            dates: { first_seen: 's', last_seen: 's', resolved_at: 's', due_at: 's', ignored_at: 's' }
        },
        ft_cve_finding_assets: {
            file: 'constats-elements.json',
            where: 'finding_id IN (SELECT id FROM ft_cve_findings WHERE workspace_id = ?)',
            key: ['finding_id', 'asset_id']
        },
        ft_cve_osv_queries: {
            skip: 'Le cache des réponses du catalogue public OSV, commun à tout le serveur : aucun compte n’y figure.'
        },
        ft_cve_osv_vulns: {
            skip: 'Les avis publics du catalogue OSV, gardés en cache pour tout le serveur : aucun compte n’y figure.'
        }
    },
    store: { omit: [NVD_KEY_STORE_KEY] }
};
