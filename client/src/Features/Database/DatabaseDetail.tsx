import { useState } from 'react';
import type { Database, DatabaseAlert, DatabaseProbe, DatabaseUsage } from 'deveye-types';
import { Button } from '@/Components';
import { STATUS_LABELS } from '../Projects/api';
import { AlertDialog } from './AlertDialog';
import { TableExplorer } from './TableExplorer';
import { ENGINE_LABELS, formatAgo, formatBytes, formatCount, formatInterval, STATUS_META } from './format';
import styles from './style.module.css';

interface DatabaseDetailProps {
    database: Database;
    usage: DatabaseUsage[];
    alerts: DatabaseAlert[];
    canWrite: boolean;
    busy: boolean;
    /** Le dernier essai de connexion, s'il y en a eu un dans cette vue. */
    probe: DatabaseProbe | null;
    onBack: () => void;
    onEdit: () => void;
    onTest: () => void;
    onInspect: () => void;
    onAlertsChanged: () => void;
    onRemoveAlert: (alertId: number) => void;
    onOpenProject: (projectId: number) => void;
}

/**
 * Une base ouverte : son état, ses alertes, ses tables, ses projets.
 *
 * L'ordre des blocs suit ce qu'on vient y chercher : **est-elle joignable**,
 * **qu'est-ce qui la surveille**, **qu'y a-t-il dedans**, **qui s'en sert**.
 * L'exploration est en troisième position et non en première parce qu'elle est
 * la seule qui ouvre une connexion — on ne la déclenche pas par accident en
 * ouvrant l'écran.
 */
export function DatabaseDetail({
    database,
    usage,
    alerts,
    canWrite,
    busy,
    probe,
    onBack,
    onEdit,
    onTest,
    onInspect,
    onAlertsChanged,
    onRemoveAlert,
    onOpenProject
}: DatabaseDetailProps) {
    const [alertDialog, setAlertDialog] = useState<{ alert: DatabaseAlert | null } | null>(null);
    const status = STATUS_META[database.status];

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div className={styles.detailHead}>
                    <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                        Bases
                    </Button>
                    <div className={styles.ident}>
                        <p className={styles.cardName}>
                            <span className={styles.statusDot} data-tone={status.tone} aria-hidden='true' />
                            {database.name}
                        </p>
                        <p className={styles.cardMeta}>
                            {ENGINE_LABELS[database.engine]} · {database.host}:{database.port}/{database.database}
                            {database.access.kind !== 'direct' && (
                                <span className={styles.viaTag}>
                                    via {database.access.kind === 'ssh' ? 'SSH' : 'SOCKS'} {database.access.host}
                                </span>
                            )}
                        </p>
                        {database.lastError && <p className={styles.error}>{database.lastError}</p>}
                    </div>
                </div>
                {canWrite && (
                    <div className={styles.actions}>
                        <Button variant='secondary' icon='refresh' onClick={onTest} disabled={busy}>
                            Tester
                        </Button>
                        <Button variant='secondary' icon='search' onClick={onInspect} disabled={busy}>
                            Relever
                        </Button>
                        <Button variant='secondary' icon='edit' onClick={onEdit} disabled={busy}>
                            Modifier
                        </Button>
                    </div>
                )}
            </header>

            {/* Le résultat d'un test à la demande, à part de l'état enregistré :
                l'un dit « en ce moment », l'autre « au dernier relevé ». */}
            {probe && (
                <p className={probe.ok ? styles.ok : styles.error}>
                    {probe.ok
                        ? `Connexion réussie en ${probe.elapsedMs} ms — ${probe.serverVersion}`
                        : `Connexion impossible : ${probe.error}`}
                </p>
            )}

            <section className={styles.statRow}>
                <Stat label='État' value={status.label} tone={status.tone} />
                <Stat
                    label='Surveillance'
                    value={
                        database.monitorEnabled
                            ? `toutes les ${formatInterval(database.intervalSeconds)}`
                            : 'à la demande'
                    }
                />
                <Stat label='Dernier relevé' value={formatAgo(database.lastCheckAt)} />
                <Stat label='Taille' value={formatBytes(database.sizeBytes)} />
                <Stat label='Tables' value={formatCount(database.tableCount)} />
                <Stat label='Version' value={database.serverVersion ?? '—'} />
            </section>

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
                    {canWrite && (
                        <Button variant='secondary' icon='add' onClick={() => setAlertDialog({ alert: null })}>
                            Nouvelle alerte
                        </Button>
                    )}
                </header>

                {!database.monitorEnabled && alerts.length > 0 && (
                    <p className={styles.warn}>
                        La surveillance est éteinte : ces alertes ne sont <strong>pas évaluées</strong>. Activez le
                        relevé régulier dans « Modifier » pour les rendre vivantes.
                    </p>
                )}

                {alerts.length === 0 && (
                    <p className={styles.hint}>
                        Aucune alerte. Une alerte compare le résultat de requêtes à des seuils — nombre d’erreurs de la
                        dernière heure, utilisateurs actifs, lignes en attente — et prévient sur les canaux de l’espace.
                    </p>
                )}

                <ul className={styles.alertList}>
                    {alerts.map((alert) => (
                        <li key={alert.id} className={alert.firing ? styles.alertRowOn : styles.alertRow}>
                            <button
                                type='button'
                                className={styles.alertButton}
                                disabled={!canWrite}
                                onClick={() => setAlertDialog({ alert })}
                            >
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
                                        ` · ${alert.lastValues.map((v) => (v === null ? '—' : v)).join(' / ')}`}
                                </span>
                                {alert.lastError && <span className={styles.error}>{alert.lastError}</span>}
                            </button>
                        </li>
                    ))}
                </ul>
            </section>

            <TableExplorer databaseId={database.id} />

            {/*
             * Les projets qui s'en servent — le second sens de l'interconnexion.
             * Masqué quand il n'y en a aucun : un panneau vide n'apprend rien.
             */}
            {usage.length > 0 && (
                <section className={styles.panel}>
                    <h3 className={styles.panelTitle}>
                        {usage.length} projet{usage.length > 1 ? 's' : ''}
                    </h3>
                    <ul className={styles.usageList}>
                        {usage.map((u) => (
                            <li key={u.projectId}>
                                <button
                                    type='button'
                                    className={styles.usageItem}
                                    onClick={() => onOpenProject(u.projectId)}
                                >
                                    <span className='icon icon-projects' />
                                    <span>{u.title}</span>
                                    <span className={styles.status} data-status={u.status}>
                                        {STATUS_LABELS[u.status]}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <AlertDialog
                open={alertDialog !== null}
                databaseId={database.id}
                alert={alertDialog?.alert ?? null}
                monitorEnabled={database.monitorEnabled}
                onClose={() => setAlertDialog(null)}
                onSaved={() => {
                    setAlertDialog(null);
                    onAlertsChanged();
                }}
                onRemove={
                    canWrite && alertDialog?.alert
                        ? () => {
                              onRemoveAlert(alertDialog.alert!.id);
                              setAlertDialog(null);
                          }
                        : undefined
                }
            />
        </div>
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

export default DatabaseDetail;
