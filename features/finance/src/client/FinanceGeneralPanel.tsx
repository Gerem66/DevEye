import { useCallback, useEffect, useState } from 'react';
import { Button, humanizeError, SelectInput, settingsStyles as shell, Switch } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { FinanceConfig } from '../contracts/domain';

import { api, refreshFinance } from './api';

/**
 * Une liste courte plutôt que les cent soixante codes ISO ; le contrat reste un
 * code ISO, élargir ne demande qu'une ligne ici.
 */
const CURRENCIES = [
    { code: 'EUR', label: 'Euro (€)' },
    { code: 'USD', label: 'Dollar américain ($)' },
    { code: 'GBP', label: 'Livre sterling (£)' },
    { code: 'CHF', label: 'Franc suisse (CHF)' },
    { code: 'CAD', label: 'Dollar canadien (CA$)' }
];

/**
 * Panneau Général : devise et mode entreprise (la TVA sur les saisies et son
 * récapitulatif). Après l'enregistrement, `refreshFinance` : tout l'écran
 * dépend de la devise, jusqu'au symbole de chaque montant.
 */
export default function FinanceGeneralPanel({ canWrite }: SettingsPanelProps) {
    const [draft, setDraft] = useState<FinanceConfig | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await api.send('finance.config', {});
            setDraft(res.config);
        } catch (e) {
            setError(humanizeError(e, 'Les réglages n’ont pas pu être lus.'));
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const submit = async () => {
        if (busy || !draft) return;
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('finance.configUpdate', { config: draft });
            setDraft(res.config);
            refreshFinance();
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    if (!draft) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.fieldLabel}>Devise</span>
                <SelectInput
                    value={draft.currency}
                    disabled={!canWrite}
                    onChange={(e) => setDraft((d) => (d ? { ...d, currency: e.target.value } : d))}
                >
                    {CURRENCIES.map((entry) => (
                        <option key={entry.code} value={entry.code}>
                            {entry.label}
                        </option>
                    ))}
                </SelectInput>
                <span className={shell.fieldHint}>
                    Une seule devise par espace. Les montants déjà saisis ne sont pas convertis: changer de devise ne
                    fait que changer le symbole affiché.
                </span>
            </div>

            <Switch
                checked={draft.vatEnabled}
                disabled={!canWrite}
                onChange={(value) => setDraft((d) => (d ? { ...d, vatEnabled: value } : d))}
                label='Mode entreprise (TVA)'
                hint='Ajoute la TVA aux saisies et son récapitulatif collectée / déductible au tableau de bord.'
            />

            {canWrite ? (
                <div className={shell.sectionActions}>
                    <Button onClick={() => void submit()} disabled={busy}>
                        {busy ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </div>
            ) : (
                <p className={shell.sectionHint}>
                    Votre rôle ne permet pas de modifier ces réglages : ils relèvent de l’écriture sur Finances.
                </p>
            )}

            {error && <p className={shell.notice}>{error}</p>}
        </div>
    );
}
