import { useEffect, useState } from 'react';
import {
    humanizeError,
    invalidate,
    ReadOnlyNotice,
    SaveButton,
    SearchSelect,
    SegmentedControl,
    settingsStyles as shell,
    useResource
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { DEFAULT_SETTINGS, type ConvertSettings } from '../contracts/domain';
import { api } from './api';
import { currencyOption } from './currencies';

const NOTIFY_OPTIONS = [
    { value: '0', label: 'Toujours' },
    { value: '60', label: 'Après 1 min' },
    { value: '300', label: 'Après 5 min' },
    { value: '900', label: 'Après 15 min' }
] as const;

export default function GeneralPanel({ canWrite }: SettingsPanelProps) {
    const stored = useResource(
        'convert.settings',
        () => api.send('convert.settingsGet', {}).then((r) => r.settings),
        'Impossible de lire les réglages.'
    );
    const rates = useResource('convert.rates', () => api.send('convert.rates', {}), 'Impossible de lire les devises.');
    const [draft, setDraft] = useState<ConvertSettings>(DEFAULT_SETTINGS);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (stored.data) setDraft(stored.data);
    }, [stored.data]);

    const codes = Object.keys(rates.data?.rates ?? { [draft.baseCurrency]: 1 }).sort();
    const save = async (): Promise<void> => {
        setError(null);
        try {
            await api.send('convert.settingsSet', { settings: draft });
            invalidate('convert.settings');
        } catch (e) {
            setError(humanizeError(e, 'Les réglages n’ont pas pu être enregistrés.'));
            throw e;
        }
    };

    return (
        <div className={shell.section}>
            <span className={shell.sectionLabel}>Devise de référence</span>
            <p className={shell.sectionHint}>
                Celle que le convertisseur de devises propose en premier, pour tout l’espace.
            </p>
            <SearchSelect
                aria-label='Devise de référence'
                searchPlaceholder='Nom, code ou pays…'
                disabled={!canWrite}
                value={draft.baseCurrency}
                options={codes.map(currencyOption)}
                onChange={(baseCurrency) => setDraft({ ...draft, baseCurrency })}
            />

            <span className={shell.sectionLabel}>Avis de fin de conversion</span>
            <p className={shell.sectionHint}>
                Une conversion longue prévient quand elle est finie, sur les canaux de l’onglet Notifications. Les
                conversions courtes restent silencieuses : on est encore devant l’écran.
            </p>
            <SegmentedControl
                aria-label='Prévenir à la fin d’une conversion'
                fullWidth
                disabled={!canWrite}
                value={String(draft.notifyAfterSeconds) as (typeof NOTIFY_OPTIONS)[number]['value']}
                options={[...NOTIFY_OPTIONS]}
                onChange={(value) => setDraft({ ...draft, notifyAfterSeconds: Number(value) })}
            />

            {canWrite ? (
                <SaveButton onSave={save} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier ces réglages : ils relèvent de l’écriture sur le Convertisseur.
                </ReadOnlyNotice>
            )}
            {error && <p className={shell.notice}>{error}</p>}
        </div>
    );
}
