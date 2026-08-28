import { useState } from 'react';
import { Button, humanizeError, invalidate, settingsStyles as shell, useResource } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { DatabaseAlert } from '../contracts/domain';

import { AlertDialog } from './AlertDialog';
import { api } from './api';
import { formatAgo } from './format';
import styles from './style.module.css';

/**
 * Les alertes d'une base : l'onglet Alertes de sa coquille de réglages.
 *
 * C'était un dialogue à part, derrière son propre « Nouvelle alerte » dans le
 * corps de la fiche (la dette de la coquille) : une règle d'alerte est un
 * réglage de la base, au même titre que sa cadence de relevé ou ses canaux, et
 * tout réglage passe par la coquille. La fiche garde l'ÉTAT des alertes
 * (franchie, dernières mesures, erreur) ; ce panneau les ÉCRIT, par le
 * dialogue de la feature (`AlertDialog`, dont la zone danger supprime).
 *
 * Rangées : les mêmes formes que la liste des canaux de la section
 * Notifications, exprès (`settingsStyles`) ; seules les pastilles restent
 * celles de la feature, qui les partage avec sa fiche.
 *
 * Autonome, comme tous les panneaux de la coquille : il se charge
 * (`database.get`, qui rend la base ET ses alertes en une lecture : la base
 * dit si la surveillance tourne, sans quoi les règles sont inertes, et si
 * elle vient d'un autre espace), s'invalide et se rafraîchit tout seul.
 */
export default function DatabaseAlertsPanel({ scope, canWrite }: SettingsPanelProps) {
    const itemId = scope.kind === 'item' ? scope.itemId : null;
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
    // `!database.foreign` : la ligne se réécrit sous la clé de SON espace, le
    // serveur le refuse, l'écran ne le propose donc pas.
    const editable = canWrite && !database.foreign;

    /** Une alerte qui change touche la fiche (ses règles) et la liste (le compte franchi). */
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
