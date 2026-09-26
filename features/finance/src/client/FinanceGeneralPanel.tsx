import { useCallback, useEffect, useState } from 'react';
import { FeatureSettingsButton, humanizeError, settingsStyles as shell, StatusBadge } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { FinanceConfig } from '../contracts/domain';

import { api } from './api';

/**
 * Panneau Général de la feature. La devise et la TVA ne se règlent pas ici :
 * Facturation en a besoin pour émettre, elle les tient, et le livre les suit.
 * Deux réglages au même nom dans deux features finiraient par se contredire.
 */
export default function FinanceGeneralPanel(_props: SettingsPanelProps) {
    const [config, setConfig] = useState<FinanceConfig | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setConfig((await api.send('finance.config', {})).config);
        } catch (e) {
            setError(humanizeError(e, 'Les réglages n’ont pas pu être lus.'));
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    if (config === null) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    const currency = new Intl.DisplayNames('fr-FR', { type: 'currency' }).of(config.currency) ?? config.currency;

    /** Le chemin vers le réglage, dans la phrase qui le nomme : un rôle sans accès à Facturation ne le voit pas. */
    const settingIn = (section: string) =>
        config.invoicing.available ? (
            <>
                {' '}
                <FeatureSettingsButton
                    scope={{ kind: 'feature', feature: 'invoicing' }}
                    initialSection={section}
                    variant='link'
                    label='Régler dans Facturation'
                />
            </>
        ) : null;

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.fieldLabel}>Devise</span>
                <span>
                    {currency.charAt(0).toUpperCase() + currency.slice(1)} ({config.currency})
                </span>
                <span className={shell.fieldHint}>
                    Celle de vos factures : un règlement dans une autre devise reste dans Facturation.
                    {settingIn('general')}
                </span>
            </div>

            <div className={shell.field}>
                <span className={shell.fieldLabel}>TVA</span>
                <span>
                    <StatusBadge tone={config.vatEnabled ? 'accent' : 'neutral'} dot={false}>
                        {config.vatEnabled ? 'Suivie' : 'Non suivie'}
                    </StatusBadge>
                </span>
                <span className={shell.fieldHint}>
                    {config.vatEnabled
                        ? 'Vos factures portent de la TVA : elle apparaît sur chaque saisie, et son récapitulatif à l’accueil.'
                        : 'Vos factures ne portent pas de TVA (franchise en base) : le livre n’en suit pas.'}
                    {settingIn('taxes')}
                </span>
            </div>

            {!config.invoicing.available && (
                <p className={shell.fieldHint}>Sans Facturation, le livre tient ses montants en euros, sans TVA.</p>
            )}
        </div>
    );
}
