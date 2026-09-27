import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { InvoicingRepo } from './repo';

export const invoicingAccountExport: FeatureAccountExport<InvoicingRepo> = {
    tables: {
        ft_invoicing_settings: {
            file: 'reglages.json',
            where: 'workspace_id = ?',
            key: ['workspace_id'],
            sealed: ['content'],
            json: ['content'],
            dates: { updated: 's' }
        },
        ft_invoicing_clients: {
            file: 'clients.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { created: 's', updated: 's' }
        },
        ft_invoicing_docs: {
            file: 'documents.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['issuer_snapshot', 'client_snapshot', 'content'],
            json: ['issuer_snapshot', 'client_snapshot', 'content'],
            dates: { accepted_at: 's', sent_at: 's', reminded_at: 's', created: 's', updated: 's' },
            omit: ['public_token']
        },
        ft_invoicing_lines: {
            file: 'lignes.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content']
        },
        ft_invoicing_payments: {
            file: 'reglements.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { created: 's' }
        },
        ft_invoicing_deductions: {
            file: 'deductions.json',
            where: 'workspace_id = ?',
            key: ['id'],
            dates: { created: 's' }
        }
    }
};
