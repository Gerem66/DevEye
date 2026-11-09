import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { PdfRepo } from './repo';

export const pdfAccountExport: FeatureAccountExport<PdfRepo> = {
    tables: {
        ft_pdf_signatures: {
            file: 'signatures.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['data_enc'],
            dates: { created: 's' }
        }
    }
};
