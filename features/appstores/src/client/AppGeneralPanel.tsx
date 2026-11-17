import { useState } from 'react';
import {
    Button,
    ConfirmDialog,
    ErrorNote,
    errorNote,
    invalidate,
    ReadOnlyNotice,
    SaveButton,
    settingsStyles as shell,
    TextInput,
    type ConfirmRequest,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import { APPSTORES_APP_NAME_MAX_LENGTH } from '../contracts/domain';

import { api } from './api';
import { changedApp, updateOf, useSettingsApp } from './appSettings';

/**
 * L'app elle-même : son nom et sa suppression. Ses fiches de store, le pays
 * de sa note et sa synchronisation ont leur onglet, Stores.
 */
export default function AppGeneralPanel({ scope, canWrite, gone }: SettingsPanelProps) {
    const appId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const { app, setApp, loadError } = useSettingsApp(appId, (loaded) => setName(loaded.name));

    if (!app) return loadError ? <ErrorNote note={loadError} /> : <p className={shell.empty}>Chargement…</p>;

    // Elle se règle chez elle : le serveur refuse de régler une app projetée ici.
    if (app.foreign) {
        return (
            <p className={shell.sectionHint}>
                Cette app vient d’un autre espace : son nom, ses fiches de store et sa suppression se règlent depuis
                là-bas.
            </p>
        );
    }

    const save = async () => {
        setError(null);
        try {
            const res = await api.send('appstores.update', updateOf(app, { name: name.trim() }));
            setApp(res.app);
            setName(res.app.name);
            changedApp();
        } catch (e) {
            setError(errorNote(e, 'L’enregistrement a échoué.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw e;
        }
    };

    const remove = async () => {
        setBusy(true);
        setError(null);
        try {
            await api.send('appstores.remove', { appId: app.id });
            // La fiche s'en va AVANT que la liste se relise : relue après coup, elle chercherait une app disparue.
            gone();
            invalidate('appstores.list', 'appstores.count', 'appstores.detail', 'projects.board');
        } catch (e) {
            setError(errorNote(e, 'La suppression a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const projects =
        app.projectCount === 1
            ? 'le projet qui la relie perd son lien'
            : app.projectCount > 1
              ? `les ${app.projectCount} projets qui la relient perdent leur lien`
              : 'les projets qui la relieraient perdraient leur lien';

    return (
        <div className={shell.section}>
            <label className={shell.field}>
                <span className={shell.sectionLabel}>Nom</span>
                <TextInput
                    value={name}
                    disabled={!canWrite || busy}
                    maxLength={APPSTORES_APP_NAME_MAX_LENGTH}
                    onChange={(e) => setName(e.target.value)}
                />
            </label>

            {canWrite ? (
                <SaveButton onSave={save} disabled={busy || name.trim() === '' || name.trim() === app.name} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier une app : cela relève de l’écriture sur Stores.
                </ReadOnlyNotice>
            )}

            {canWrite && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Supprimer cette app</span>
                    <span className={shell.fieldHint}>
                        Ses chiffres, ses avis et ses revenus relevés sont perdus, et {projects}. L’app sur l’App Store
                        et sur Google Play, elle, n’est pas touchée.
                    </span>
                    <div className={shell.sectionActions}>
                        <Button
                            variant='danger'
                            disabled={busy}
                            onClick={() =>
                                setConfirm({
                                    title: `Supprimer « ${app.name} » ?`,
                                    description: `Ses chiffres, ses avis et ses revenus relevés sont perdus, et ${projects}. Rien ne change chez Apple ni chez Google.`,
                                    confirmLabel: 'Supprimer l’app',
                                    onConfirm: () => void remove()
                                })
                            }
                        >
                            Supprimer l’app
                        </Button>
                    </div>
                </div>
            )}

            <ErrorNote note={error} />
            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
