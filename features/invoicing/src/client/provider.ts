import type { InvoicingClientProvider } from '@deveye/types/sdk/client';

import { api, refreshInvoicing } from './api';

/** Un règlement reconnu ailleurs (une ligne de relevé dans Finances), enregistré comme s'il était saisi ici. */
export const clientProvider: InvoicingClientProvider = {
    async recordPayment({ docId, paidOn, amountCents, reference }) {
        await api.send('invoicing.paymentSave', {
            docId,
            payment: { paidOn, amountCents, method: 'transfer', reference, note: '' }
        });
        refreshInvoicing();
    }
};
