import { useState, type ReactNode } from 'react';
import type { Database, DatabaseAlert, DatabaseProbe } from 'deveye-types';
import { Button } from '@/Components';
import { AlertDialog } from './AlertDialog';
import { TableExplorer } from './TableExplorer';
import { formatAgo, formatBytes, formatCount, formatInterval, STATUS_META } from './format';
import styles from './style.module.css';

interface DatabaseViewProps {
    database: Database;
    alerts: DatabaseAlert[];
    canWrite: boolean;
    /** Le dernier essai de connexion, s'il y en a eu un dans cette vue. */
    probe: DatabaseProbe | null;
    onAlertsChanged: () => void;
    onRemoveAlert: (alertId: number) => void;
    /** Rendu après l'explorateur (les projets liés, par exemple). */
    children?: ReactNode;
}

/**
 * Le contenu d'une base : son état, ses alertes, ses tables.
 *
 * **Partagé** entre la feature Bases de données (`DatabaseDetail`) et l'onglet
 * « Bases de données » d'un projet, exactement comme `RepoView` l'est entre la
 * feature Git et l'onglet Git. C'est la raison d'être du composant : les deux
 * montrent la même base, et une seconde implémentation aurait divergé au premier
 * ajustement.
 *
 * L'en-tête — nom, adresse, boutons — appartient à l'appelant : la feature y met
 * un retour à la liste, l'onglet d'un projet y met un « Délier ».
 *
 * L'ordre des blocs suit ce qu'on vient y chercher : **est-elle joignable**,
 * **qu'est-ce qui la surveille**, **qu'y a-t-il dedans**. L'exploration vient en
 * dernier et non en premier parce qu'elle est la seule qui ouvre une connexion —
 * on ne la déclenche pas par accident en affichant l'écran.
 */
export function DatabaseView({
    database,
    alerts,
    canWrite,
    probe,
    onAlertsChanged,
    onRemoveAlert,
    children
}: DatabaseViewProps) {
    const [alertDialog, setAlertDialog] = useState<{ alert: DatabaseAlert | null } | null>(null);
    const status = STATUS_META[database.status];

    return (
        <>
            {/* Le résultat d'un test à la demande, à part de l'état enregistré :
                l'un dit « en ce moment », l'autre « au dernier relevé ». */}
            {probe && (
                <p className={probe.ok ? styles.ok : styles.error}>
                    {probe.ok
                        ? `Connexion réussie en ${probe.elapsedMs} ms · ${probe.serverVersion}`
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

            {/* Dire d'où viennent ces chiffres, sans quoi on les croit lus à
                l'instant — alors qu'ils datent du dernier relevé, lequel peut
                n'avoir jamais eu lieu. */}
            {database.lastCheckAt === null && (
                <p className={styles.hint}>
                    Ces chiffres sont vides : cette base n’a jamais été relevée. « Relever l’état » va les chercher.
                </p>
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

            <TableExplorer
                databaseId={database.id}
                databaseName={database.name}
                autoLoad={canWrite && database.autoLoadTables}
            />

            {children}

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

export default DatabaseView;
