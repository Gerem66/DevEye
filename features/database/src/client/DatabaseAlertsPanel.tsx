import { useState } from 'react';
import { Button, humanizeError, invalidate, settingsStyles as shell, useResource } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { DatabaseAlert } from '../contracts/domain';

import { AlertDialog } from './AlertDialog';
import { api } from './api';
import { formatAgo } from './format';
import styles from './style.module.css';

/**
 * L'onglet Alertes d'une base : la fiche montre l'état des alertes, ce panneau
 * les écrit par `AlertDialog`. Rangées aux formes de la liste des canaux
 * (`settingsStyles`). Autonome : `database.get` rend la base et ses alertes.
 */
export default function DatabaseAlertsPanel({ scope, canWrite }: SettingsPanelProps) {
    const itemId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const { data, error: loadError } = useResource(
        'database.detail',
        () => api.send('database.get', { databaseId: itemId ?? 0 }),
        'Chargement impossible.',
        [itemId]
    );
    const [dialog, setDialog] = useState<{ alert: DatabaseAlert | null } | null>(null);
    const [error, setError] = useState<string | null>(null);

    if (!data) return <p className={loadError ? shell.notice : shell.empty}>{loadError ?? 'Chargement…'}</p>;

    const { database, alerts } = data;
    // Une base projetée se règle chez elle : le serveur le refuse ici.
    const editable = canWrite && !database.foreign;

    /** Touche la fiche (ses règles) et la liste (le compte franchi). */
    const changed = () => invalidate('database.detail', 'database.list');

    const remove = async (alertId: number) => {
        setError(null);
        try {
            await api.send('database.alertRemove', { alertId });
            changed();
        } catch (e) {
            setError(humanizeError(e, 'La suppression de l’alerte a échoué.'));
        }
    };

    return (
        <div className={shell.section}>
            {database.foreign && (
                <p className={shell.sectionHint}>
                    Cette base vient d’un autre espace : ses alertes se règlent depuis là-bas.
                </p>
            )}

            {!database.monitorEnabled && alerts.length > 0 && (
                <p className={styles.warn}>
                    La surveillance est éteinte : ces alertes ne sont <strong>pas évaluées</strong>. Activez le relevé
                    régulier dans l’onglet Général pour les rendre vivantes.
                </p>
            )}

            {alerts.length === 0 && (
                <p className={shell.empty}>
                    Aucune alerte. Une alerte compare le résultat de requêtes à des seuils (nombre d’erreurs de la
                    dernière heure, utilisateurs actifs, lignes en attente) et prévient sur les canaux de l’espace.
                </p>
            )}

            <div className={shell.channelList}>
                {alerts.map((alert) => (
                    <div key={alert.id} className={shell.channelRow}>
                        <span className={`icon icon-activity ${shell.channelIcon}`} aria-hidden='true' />
                        <span className={shell.channelText}>
                            <span className={shell.channelLabel}>
                                {alert.name}
                                {!alert.enabled && <span className={styles.tag}>désactivée</span>}
                                {alert.firing && <span className={styles.alertTag}>franchie</span>}
                            </span>
                            <span className={shell.channelMeta}>
                                {alert.conditions.length} condition{alert.conditions.length > 1 ? 's' : ''} ·{' '}
                                {alert.combinator === 'and' ? 'toutes' : 'au moins une'}
                                {alert.lastCheckAt !== null && ` · évaluée ${formatAgo(alert.lastCheckAt)}`}
                                {alert.lastValues.length > 0 &&
                                    ` · ${alert.lastValues.map((v) => (v === null ? '—' : v)).join(' / ')}`}
                            </span>
                            {alert.lastError && <span className={shell.errorText}>{alert.lastError}</span>}
                        </span>
                        {editable && (
                            <span className={shell.channelActions}>
                                <button
                                    type='button'
                                    className={shell.rowAction}
                                    title='Modifier cette alerte'
                                    aria-label={`Modifier ${alert.name}`}
                                    onClick={() => setDialog({ alert })}
                                >
                                    <span className='icon icon-edit' />
                                </button>
                            </span>
                        )}
                    </div>
                ))}
            </div>

            {error && <p className={shell.notice}>{error}</p>}

            {editable ? (
                <div className={shell.sectionActions}>
                    <Button variant='secondary' icon='add' onClick={() => setDialog({ alert: null })}>
                        Nouvelle alerte
                    </Button>
                </div>
            ) : (
                !database.foreign && (
                    <p className={shell.sectionHint}>
                        Votre rôle ne permet pas de modifier les alertes : elles relèvent de l’écriture sur Bases de
                        données.
                    </p>
                )
            )}

            <AlertDialog
                open={dialog !== null}
                databaseId={database.id}
                alert={dialog?.alert ?? null}
                monitorEnabled={database.monitorEnabled}
                onClose={() => setDialog(null)}
                onSaved={() => {
                    setDialog(null);
                    changed();
                }}
                onRemove={
                    editable && dialog?.alert
                        ? () => {
                              const alertId = dialog.alert!.id;
                              setDialog(null);
                              void remove(alertId);
                          }
                        : undefined
                }
            />
        </div>
    );
}
