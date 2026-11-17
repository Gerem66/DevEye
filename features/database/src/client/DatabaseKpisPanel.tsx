import { useState } from 'react';
import {
    Button,
    errorNote,
    ErrorNote,
    invalidate,
    ReadOnlyNotice,
    settingsStyles as shell,
    useResource,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import { DATABASE_KPI_MAX, type DatabaseKpi } from '../contracts/domain';

import { AlertDialog, type AlertDraft } from './AlertDialog';
import { api } from './api';
import { formatAgo, formatKpiValue } from './format';
import { KpiDialog } from './KpiDialog';
import styles from './style.module.css';

/** L'alerte qu'un indicateur propose : sa requête, à comparer à sa valeur du moment. */
function alertDraftOf(kpi: DatabaseKpi): AlertDraft {
    return {
        name: kpi.label,
        condition: { sql: kpi.sql, comparator: 'gt', threshold: kpi.value ?? 0, label: kpi.label },
        message: `${kpi.label} : {${kpi.label}}${kpi.unit ? ` ${kpi.unit}` : ''}`
    };
}

/**
 * L'onglet Indicateurs d'une base : la fiche montre leurs tuiles, ce panneau
 * les écrit par `KpiDialog`, et tend de chacun une alerte déjà remplie.
 */
export default function DatabaseKpisPanel({ scope, canWrite }: SettingsPanelProps) {
    const itemId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const { data, error: loadError } = useResource(
        'database.detail',
        () => api.send('database.get', { databaseId: itemId ?? 0 }),
        'Chargement impossible.',
        [itemId]
    );
    const [dialog, setDialog] = useState<{ kpi: DatabaseKpi | null } | null>(null);
    const [alertDraft, setAlertDraft] = useState<AlertDraft | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    if (!data) return loadError ? <ErrorNote note={loadError} /> : <p className={shell.empty}>Chargement…</p>;

    const { database, kpis } = data;
    // Une base projetée se règle chez elle : le serveur le refuse ici.
    const editable = canWrite && !database.foreign;
    const full = kpis.length >= DATABASE_KPI_MAX;

    /** Touche la fiche (ses tuiles) et la liste (le compte d'alertes). */
    const changed = () => invalidate('database.detail', 'database.list');

    const remove = async (kpiId: string) => {
        setError(null);
        try {
            await api.send('database.kpiRemove', { databaseId: database.id, kpiId });
            changed();
        } catch (e) {
            setError(errorNote(e, 'La suppression de l’indicateur a échoué.'));
        }
    };

    return (
        <div className={shell.section}>
            {database.foreign && (
                <p className={shell.sectionHint}>
                    Cette base vient d’un autre espace : ses indicateurs se règlent depuis là-bas.
                </p>
            )}

            {kpis.length === 0 && (
                <p className={shell.empty}>
                    Aucun indicateur. Un indicateur garde sous les yeux le résultat d’une requête : commandes du jour,
                    chiffre d’affaires, stock le plus bas. Il est mesuré à son enregistrement, puis à chaque relevé.
                </p>
            )}

            <div className={shell.channelList}>
                {kpis.map((kpi) => (
                    <div key={kpi.id} className={shell.channelRow}>
                        <span className={`icon icon-chart ${shell.channelIcon}`} aria-hidden='true' />
                        <span className={shell.channelText}>
                            <span className={shell.channelLabel}>
                                {kpi.label}
                                {kpi.value !== null && (
                                    <span className={styles.kpiInline}>
                                        {formatKpiValue(kpi.value)}
                                        {kpi.unit && ` ${kpi.unit}`}
                                    </span>
                                )}
                            </span>
                            <span className={shell.channelMeta}>
                                {kpi.measuredAt === null ? 'jamais mesuré' : `mesuré ${formatAgo(kpi.measuredAt)}`}
                            </span>
                            {kpi.error && <span className={shell.errorText}>{kpi.error}</span>}
                        </span>
                        {editable && (
                            <span className={shell.channelActions}>
                                <button
                                    type='button'
                                    className={shell.rowAction}
                                    title='Créer une alerte sur cet indicateur'
                                    aria-label={`Créer une alerte sur ${kpi.label}`}
                                    onClick={() => setAlertDraft(alertDraftOf(kpi))}
                                >
                                    <span className='icon icon-activity' />
                                </button>
                                <button
                                    type='button'
                                    className={shell.rowAction}
                                    title='Modifier cet indicateur'
                                    aria-label={`Modifier ${kpi.label}`}
                                    onClick={() => setDialog({ kpi })}
                                >
                                    <span className='icon icon-edit' />
                                </button>
                            </span>
                        )}
                    </div>
                ))}
            </div>

            <ErrorNote note={error} />

            {editable ? (
                <div className={shell.sectionActions}>
                    <Button variant='secondary' icon='add' disabled={full} onClick={() => setDialog({ kpi: null })}>
                        Nouvel indicateur
                    </Button>
                    {full && (
                        <span className={shell.sectionHint}>{DATABASE_KPI_MAX} indicateurs au plus par base.</span>
                    )}
                </div>
            ) : (
                !database.foreign && (
                    <ReadOnlyNotice>
                        Votre rôle ne permet pas de modifier les indicateurs : ils relèvent de l’écriture sur Bases de
                        données.
                    </ReadOnlyNotice>
                )
            )}

            <KpiDialog
                open={dialog !== null}
                databaseId={database.id}
                kpi={dialog?.kpi ?? null}
                onClose={() => setDialog(null)}
                onSaved={() => {
                    setDialog(null);
                    changed();
                }}
                onRemove={
                    editable && dialog?.kpi
                        ? () => {
                              const kpiId = dialog.kpi!.id;
                              setDialog(null);
                              void remove(kpiId);
                          }
                        : undefined
                }
            />

            <AlertDialog
                open={alertDraft !== null}
                databaseId={database.id}
                alert={null}
                draft={alertDraft}
                monitorEnabled={database.monitorEnabled}
                onClose={() => setAlertDraft(null)}
                onSaved={() => {
                    setAlertDraft(null);
                    changed();
                }}
            />
        </div>
    );
}
