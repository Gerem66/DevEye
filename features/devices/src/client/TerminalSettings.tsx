import { useEffect, useState } from 'react';
import { terminalUser } from '@deveye/types';
import { Button, humanizeError, SelectInput, settingsStyles as shell, TextInput } from 'deveye-sdk-client';

import { api } from './api';
import { refreshDevices, useDevices } from './store';

/**
 * Les réglages du terminal distant d'un appareil : sous quel compte une session
 * s'ouvre, et ce que fait la fin du shell. Portés par l'appareil, donc partagés
 * avec les espaces qui le voient. Une session déjà ouverte garde son compte.
 */
export function TerminalSettings({ deviceId, canWrite }: { deviceId: string; canWrite: boolean }) {
    const { devices, loading } = useDevices();
    const device = devices.find((d) => d.id === deviceId) ?? null;
    const editable = canWrite && device !== null && device.status !== 'archived';

    const [defaultUser, setDefaultUser] = useState('');
    const [closeOnExit, setCloseOnExit] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    // Ne (ré)initialise qu'au changement d'appareil : un rafraîchissement de la
    // liste remplace la référence et effacerait une saisie en cours.
    const known = device !== null;
    useEffect(() => {
        if (!device) return;
        setDefaultUser(device.terminalDefaultUser ?? '');
        setCloseOnExit(device.terminalCloseOnExit);
        setError(null);
        setSaved(false);
    }, [deviceId, known]);

    const userValid = defaultUser === '' || terminalUser.safeParse(defaultUser).success;

    const save = async () => {
        setSaving(true);
        setError(null);
        setSaved(false);
        try {
            await api.send('devices.setConfig', {
                deviceId,
                terminalDefaultUser: defaultUser === '' ? null : defaultUser,
                terminalCloseOnExit: closeOnExit
            });
            await refreshDevices();
            setSaved(true);
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setSaving(false);
        }
    };

    if (!device) {
        return (
            <p className={loading ? shell.empty : shell.notice}>{loading ? 'Chargement…' : 'Appareil introuvable.'}</p>
        );
    }

    return (
        <div className={shell.section}>
            <p className={shell.sectionHint}>
                Réglages du terminal distant de cet appareil. Une session déjà ouverte garde son compte ; « Relancer la
                session » applique le nouveau.
            </p>
            {device.status === 'archived' && (
                <p className={shell.notice}>Appareil archivé : son terminal ne s’ouvre plus.</p>
            )}
            <label className={shell.field}>
                <span className={shell.sectionLabel}>Utilisateur par défaut</span>
                <TextInput
                    value={defaultUser}
                    onChange={(e) => setDefaultUser(e.target.value)}
                    placeholder="utilisateur de l'agent"
                    spellCheck={false}
                    autoCapitalize='off'
                    autoCorrect='off'
                    disabled={!editable}
                    error={userValid ? undefined : 'Nom d’utilisateur invalide'}
                />
                <span className={shell.fieldHint}>
                    Vide : l’utilisateur de l’agent. Sinon, la session démarre sous ce compte (su -l). Pris en compte à
                    la prochaine session.
                </span>
            </label>

            <label className={shell.field}>
                <span className={shell.sectionLabel}>À la fin de la session</span>
                <SelectInput
                    value={closeOnExit ? 'close' : 'keep'}
                    disabled={!editable}
                    onChange={(e) => setCloseOnExit(e.target.value === 'close')}
                >
                    <option value='close'>Fermer le terminal</option>
                    <option value='keep'>Garder ouvert (Relancer)</option>
                </SelectInput>
            </label>

            {error && <p className={shell.errorText}>{error}</p>}
            {editable && (
                <div className={shell.sectionActions}>
                    {saved && <span className={shell.fieldHint}>Enregistré.</span>}
                    <Button onClick={() => void save()} disabled={saving || !userValid}>
                        {saving ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </div>
            )}
        </div>
    );
}
