import { useCallback, useEffect, useState } from 'react';
import { humanizeError, invalidate } from 'deveye-sdk-client';

import type { InvoicingQuotaUsage, InvoicingSettings } from '../contracts/domain';
import { api } from './api';

/**
 * Les quatre panneaux de réglages écrivent le même objet : ils partagent donc
 * son chargement, son brouillon et son enregistrement, et ne gardent que leurs
 * champs. Chacun renvoie les réglages **en entier**, la partie qu'il ne montre
 * pas comprise, sans quoi ouvrir un panneau effacerait le voisin.
 */
export interface SettingsDraft {
    draft: InvoicingSettings | null;
    usage: InvoicingQuotaUsage | null;
    error: string | null;
    patch(change: Partial<InvoicingSettings>): void;
    save(): Promise<void>;
    busy: boolean;
}

export function useSettingsDraft(): SettingsDraft {
    const [draft, setDraft] = useState<InvoicingSettings | null>(null);
    const [usage, setUsage] = useState<InvoicingQuotaUsage | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await api.send('invoicing.config', {});
            setDraft(res.settings);
            setUsage(res.usage);
        } catch (e) {
            setError(humanizeError(e, 'Les réglages n’ont pas pu être lus.'));
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const patch = useCallback((change: Partial<InvoicingSettings>) => {
        setDraft((current) => (current ? { ...current, ...change } : current));
    }, []);

    const save = useCallback(async () => {
        if (busy || draft === null) return;
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('invoicing.configSave', { settings: draft });
            setDraft(res.settings);
            // La devise, le régime de TVA et la numérotation changent ce que
            // chaque écran affiche, jusqu'au symbole de chaque montant.
            invalidate(
                'invoicing.config',
                'invoicing.count',
                'invoicing.docList',
                'invoicing.doc',
                'invoicing.dashboard'
            );
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw e;
        } finally {
            setBusy(false);
        }
    }, [busy, draft]);

    return { draft, usage, error, patch, save, busy };
}
