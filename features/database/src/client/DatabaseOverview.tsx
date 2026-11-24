import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    errorNote,
    ErrorNote,
    invalidate,
    settingsStyles as shell,
    useSecrecy,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { DATABASE_KPI_MAX, type Database, type DatabaseAlert, type DatabaseKpi } from '../contracts/domain';

import { AlertDialog, type AlertDraft } from './AlertDialog';
import { api } from './api';
import { GUARDED_IDLE } from './DatabaseTierChoice';
import { formatAgo, formatBytes, formatCount, formatInterval, formatKpiValue, formatMs, STATUS_META } from './format';
import { KpiDialog } from './KpiDialog';
import styles from './style.module.css';

/** Un relevé de moins de cinq minutes vaut encore : rouvrir la fiche n'en lance pas un autre. */
const FRESH_SECONDS = 300;

/** L'alerte qu'un indicateur propose : sa requête, à comparer à sa valeur du moment. */
function alertDraftOf(kpi: DatabaseKpi): AlertDraft {
    return {
        name: kpi.label,
        condition: { sql: kpi.sql, comparator: 'gt', threshold: kpi.value ?? 0, label: kpi.label },
        message: `${kpi.label} : {${kpi.label}}${kpi.unit ? ` ${kpi.unit}` : ''}`
    };
}

interface DatabaseOverviewProps {
    database: Database;
    alerts: DatabaseAlert[];
    kpis: DatabaseKpi[];
    canWrite: boolean;
    /** Passer aux tables de la base ; absent là où elles suivent déjà à l'écran. */
    onOpenTables?: () => void;
}

/**
 * L'état d'une base (dernier relevé, indicateurs, alertes), partagé entre la
 * feature et l'onglet d'un projet. S'afficher relève la base si son dernier
 * relevé a vieilli. Indicateurs et alertes s'écrivent ici, chez leur domicile
 * seulement : un clic ouvre leur dialogue.
 */
export function DatabaseOverview({ database, alerts, kpis, canWrite, onOpenTables }: DatabaseOverviewProps) {
    const status = STATUS_META[database.status];
    // Une base projetée se règle chez elle : le serveur le refuse ici.
    const editable = canWrite && !database.foreign;
    const canInspect = canWrite && !database.planPaused;
    const guarded = database.securityTier === 'guarded';
    const secrecy = useSecrecy();
    // Une base protégée ne se joint que session déverrouillée : s'afficher ne
    // doit pas suffire à ouvrir l'invite du mot de passe, « Relever » le fait.
    const reachable = !guarded || !secrecy.enabled || secrecy.unlocked;

    const [inspecting, setInspecting] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [kpiDialog, setKpiDialog] = useState<{ kpi: DatabaseKpi | null } | null>(null);
    const [alertDialog, setAlertDialog] = useState<{ alert: DatabaseAlert | null; draft: AlertDraft | null } | null>(
        null
    );

    const databaseId = database.id;
    const inspect = useCallback(async () => {
        setInspecting(true);
        setError(null);
        try {
            await api.send('database.inspect', { databaseId });
            invalidate('database.list', 'database.detail', 'database.count');
        } catch (e) {
            setError(errorNote(e, 'Le relevé n’a pas pu être fait.'));
        } finally {
            setInspecting(false);
        }
    }, [databaseId]);

    /** La base dont l'affichage a déjà été traité : un relevé au plus par ouverture. */
    const openedFor = useRef<number | null>(null);
    useEffect(() => {
        if (!canInspect || !reachable || openedFor.current === databaseId) return;
        openedFor.current = databaseId;
        const age = database.lastCheckAt === null ? Infinity : Date.now() / 1000 - database.lastCheckAt;
        if (age > FRESH_SECONDS) void inspect();
    }, [canInspect, reachable, databaseId, database.lastCheckAt, inspect]);

    /** Touche la fiche (tuiles, règles) et la liste (le compte d'alertes). */
    const changed = () => invalidate('database.detail', 'database.list');

    const removeKpi = async (kpiId: string) => {
        setError(null);
        try {
            await api.send('database.kpiRemove', { databaseId, kpiId });
            changed();
        } catch (e) {
            setError(errorNote(e, 'La suppression de l’indicateur a échoué.'));
        }
    };

    const removeAlert = async (alertId: number) => {
        setError(null);
        try {
            await api.send('database.alertRemove', { alertId });
            changed();
        } catch (e) {
            setError(errorNote(e, 'La suppression de l’alerte a échoué.'));
        }
    };

    // La plus ancienne des mesures affichées : ce que dit la mention vaut pour toutes les tuiles.
    const measures = kpis.flatMap((kpi) => (kpi.measuredAt === null ? [] : [kpi.measuredAt]));
    const measuredAt = measures.length > 0 ? Math.min(...measures) : null;
    const full = kpis.length >= DATABASE_KPI_MAX;
    const editedKpi = kpiDialog?.kpi ?? null;
    const editedAlert = alertDialog?.alert ?? null;

    return (
        <>
            <ErrorNote note={error} />

            <section className={styles.statRow}>
                <Stat label='État' value={status.label} tone={status.tone} />
                <Stat
                    label='Surveillance'
                    value={
                        guarded
                            ? 'en votre présence'
                            : database.monitorEnabled
                              ? `toutes les ${formatInterval(database.intervalSeconds)}`
                              : 'éteinte'
                    }
                />
                <Stat label='Dernier relevé' value={inspecting ? 'en cours…' : formatAgo(database.lastCheckAt)} />
                <Stat label='Temps de réponse' value={formatMs(database.lastElapsedMs)} />
                <Stat label='Taille' value={formatBytes(database.sizeBytes)} />
                <Stat label='Tables' value={formatCount(database.tableCount)} />
                <Stat label='Version' value={database.serverVersion ?? '–'} />
            </section>

            {guarded && !reachable && canInspect && (
                <section className={styles.panel}>
                    <header className={styles.panelHead}>
                        <div className={styles.panelLead}>
                            <h3 className={styles.panelTitle}>Base protégée</h3>
                            <p className={styles.panelNote}>
                                Votre session est verrouillée : ce que vous lisez ici date du dernier relevé. La relever
                                demande votre mot de passe.
                            </p>
                        </div>
                        <Button variant='secondary' icon='lock' disabled={inspecting} onClick={() => void inspect()}>
                            {inspecting ? 'Relevé…' : 'Relever maintenant'}
                        </Button>
                    </header>
                </section>
            )}

            {onOpenTables && canWrite && (
                <section className={styles.panel}>
                    <header className={styles.panelHead}>
                        <div className={styles.panelLead}>
                            <h3 className={styles.panelTitle}>Tables</h3>
                            <p className={styles.panelNote}>
                                Parcourir les lignes, les rechercher, les modifier et les exporter, ou passer par le
                                terminal.
                            </p>
                        </div>
                        <Button icon='list' onClick={onOpenTables}>
                            Ouvrir les tables
                        </Button>
                    </header>
                </section>
            )}

            {/* Facultatif : sans indicateur, le bloc ne parle qu'à qui peut en poser un. */}
            {(kpis.length > 0 || editable) && (
                <section className={styles.panel}>
                    <header className={styles.panelHead}>
                        <h3 className={styles.panelTitle}>Indicateurs</h3>
                        <div className={styles.actions}>
                            {kpis.length > 0 && (
                                <span className={styles.hint}>
                                    {inspecting ? 'relevé en cours…' : measuredAt !== null && formatAgo(measuredAt)}
                                </span>
                            )}
                            {kpis.length > 0 && canInspect && (
                                <button
                                    type='button'
                                    className={shell.rowAction}
                                    title='Relever la base maintenant'
                                    aria-label='Relever la base maintenant'
                                    disabled={inspecting}
                                    onClick={() => void inspect()}
                                >
                                    <span className={`icon icon-${inspecting ? 'spinner' : 'refresh'}`} />
                                </button>
                            )}
                            {editable && (
                                <Button
                                    variant='secondary'
                                    icon='add'
                                    disabled={full}
                                    title={full ? `${DATABASE_KPI_MAX} indicateurs au plus par base.` : undefined}
                                    onClick={() => setKpiDialog({ kpi: null })}
                                >
                                    Ajouter un indicateur
                                </Button>
                            )}
                        </div>
                    </header>

                    {kpis.length === 0 ? (
                        <p className={styles.hint}>
                            Un indicateur garde sous les yeux le résultat d’une requête : commandes du jour, chiffre
                            d’affaires, stock le plus bas.
                        </p>
                    ) : (
                        <div className={styles.kpiGrid}>
                            {kpis.map((kpi) => {
                                const tile = (
                                    <>
                                        <span className={styles.statLabel}>{kpi.label}</span>
                                        <span className={styles.kpiValue}>
                                            {kpi.value === null ? '–' : formatKpiValue(kpi.value)}
                                            {kpi.value !== null && kpi.unit && (
                                                <span className={styles.kpiUnit}>{kpi.unit}</span>
                                            )}
                                        </span>
                                        {kpi.error && (
                                            <span className={styles.kpiError} title={kpi.error}>
                                                {kpi.error}
                                            </span>
                                        )}
                                    </>
                                );
                                return editable ? (
                                    <button
                                        key={kpi.id}
                                        type='button'
                                        className={styles.kpiTileButton}
                                        title='Modifier cet indicateur'
                                        onClick={() => setKpiDialog({ kpi })}
                                    >
                                        {tile}
                                    </button>
                                ) : (
                                    <div key={kpi.id} className={styles.kpiTile}>
                                        {tile}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </section>
            )}

            <section className={styles.panel}>
                <header className={styles.panelHead}>
                    <h3 className={styles.panelTitle}>
                        Alertes
                        {database.firingCount > 0 && (
                            <span className={styles.alertTag}>
                                {database.firingCount} franchie{database.firingCount > 1 ? 's' : ''}
                            </span>
                        )}
                    </h3>
                    {editable && !guarded && (
                        <Button
                            variant='secondary'
                            icon='add'
                            onClick={() => setAlertDialog({ alert: null, draft: null })}
                        >
                            Ajouter une alerte
                        </Button>
                    )}
                </header>

                {guarded && <p className={styles.hint}>{GUARDED_IDLE}</p>}

                {!guarded && !database.monitorEnabled && alerts.length > 0 && (
                    <p className={styles.warn}>
                        La surveillance est éteinte : ces alertes ne sont évaluées{' '}
                        <strong>qu’à l’ouverture de cette fiche</strong>. Activez le relevé régulier dans les réglages
                        de la base (Général) pour qu’elles préviennent sans vous.
                    </p>
                )}

                {alerts.length === 0 && !guarded && (
                    <p className={styles.hint}>
                        Aucune alerte. Une alerte compare le résultat de requêtes à des seuils (nombre d’erreurs de la
                        dernière heure, utilisateurs actifs, lignes en attente) et prévient sur les canaux de l’espace.
                    </p>
                )}

                <ul className={styles.alertList}>
                    {alerts.map((alert) => {
                        const entry = (
                            <>
                                <span className={styles.alertName}>
                                    {alert.name}
                                    {!alert.enabled && <span className={styles.tag}>désactivée</span>}
                                    {alert.firing && <span className={styles.alertTag}>franchie</span>}
                                </span>
                                <span className={styles.hint}>
                                    {alert.conditions.length} condition{alert.conditions.length > 1 ? 's' : ''} ·{' '}
                                    {alert.combinator === 'and' ? 'toutes' : 'au moins une'}
                                    {alert.lastCheckAt !== null && ` · évaluée ${formatAgo(alert.lastCheckAt)}`}
                                    {alert.lastValues.length > 0 &&
                                        ` · ${alert.lastValues.map((v) => (v === null ? '–' : v)).join(' / ')}`}
                                </span>
                                {alert.lastError && <span className={styles.error}>{alert.lastError}</span>}
                            </>
                        );
                        return (
                            <li key={alert.id} className={alert.firing ? styles.alertRowOn : styles.alertRow}>
                                {editable ? (
                                    <button
                                        type='button'
                                        className={styles.alertEntryButton}
                                        title='Modifier cette alerte'
                                        onClick={() => setAlertDialog({ alert, draft: null })}
                                    >
                                        {entry}
                                    </button>
                                ) : (
                                    <div className={styles.alertEntry}>{entry}</div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </section>

            {editable && (
                <>
                    <KpiDialog
                        open={kpiDialog !== null}
                        databaseId={databaseId}
                        kpi={editedKpi}
                        onClose={() => setKpiDialog(null)}
                        onSaved={() => {
                            setKpiDialog(null);
                            changed();
                        }}
                        onRemove={
                            editedKpi
                                ? () => {
                                      setKpiDialog(null);
                                      void removeKpi(editedKpi.id);
                                  }
                                : undefined
                        }
                        onCreateAlert={
                            editedKpi && !guarded
                                ? () => {
                                      setKpiDialog(null);
                                      setAlertDialog({ alert: null, draft: alertDraftOf(editedKpi) });
                                  }
                                : undefined
                        }
                    />

                    <AlertDialog
                        open={alertDialog !== null}
                        databaseId={databaseId}
                        alert={editedAlert}
                        draft={alertDialog?.draft ?? null}
                        monitorEnabled={database.monitorEnabled}
                        onClose={() => setAlertDialog(null)}
                        onSaved={() => {
                            setAlertDialog(null);
                            changed();
                        }}
                        onRemove={
                            editedAlert
                                ? () => {
                                      setAlertDialog(null);
                                      void removeAlert(editedAlert.id);
                                  }
                                : undefined
                        }
                    />
                </>
            )}
        </>
    );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'neutral' | 'online' | 'danger' }) {
    return (
        <div className={styles.stat}>
            <span className={styles.statLabel}>{label}</span>
            <span className={styles.statValue} data-tone={tone ?? 'neutral'}>
                {value}
            </span>
        </div>
    );
}

export default DatabaseOverview;
