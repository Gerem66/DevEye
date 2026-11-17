import { useCallback, useState, type ReactNode } from 'react';
import { FeatureSettingsButton } from 'deveye-sdk-client';
import type { Database, DatabaseAlert, DatabaseKpi, DatabaseProbe } from '../contracts/domain';

import { ProbeLine } from './ProbeLine';
import { TableExplorer } from './TableExplorer';
import { formatAgo, formatBytes, formatCount, formatInterval, formatKpiValue, formatMs, STATUS_META } from './format';
import styles from './style.module.css';

interface DatabaseViewProps {
    database: Database;
    alerts: DatabaseAlert[];
    kpis: DatabaseKpi[];
    canWrite: boolean;
    /** Un essai de connexion est en cours. */
    testing: boolean;
    /** Le dernier essai de connexion, s'il y en a eu un dans cette vue. */
    probe: DatabaseProbe | null;
    /** L'explorateur passe ou sort du plein écran ; l'appelant possède l'en-tête à effacer. */
    onExpandChange?: (expanded: boolean) => void;
    /** Supprimée depuis ses réglages (ouverts ici sur Alertes), la base n'est plus là : l'appelant quitte la fiche. */
    onGone?: () => void;
    /** Rendu après l'explorateur (les projets liés, par exemple). */
    children?: ReactNode;
}

/**
 * Le contenu d'une base (état, indicateurs, alertes, tables), partagé entre la
 * feature et l'onglet d'un projet ; l'en-tête appartient à l'appelant. Les
 * blocs Indicateurs et Alertes montrent un état, leur écriture vit dans les
 * réglages de la base. En mode agrandi, seul l'explorateur reste.
 */
export function DatabaseView({
    database,
    alerts,
    kpis,
    canWrite,
    testing,
    probe,
    onExpandChange,
    onGone,
    children
}: DatabaseViewProps) {
    const [expanded, setExpanded] = useState(false);
    const status = STATUS_META[database.status];
    const scope = {
        kind: 'item' as const,
        feature: 'database' as const,
        itemId: String(database.id),
        itemLabel: database.name
    };

    // Stable : l'explorateur s'en sert dans un effet de remise à zéro.
    const expand = useCallback(
        (next: boolean) => {
            setExpanded(next);
            onExpandChange?.(next);
        },
        [onExpandChange]
    );

    return (
        <>
            {!expanded && (
                <>
                    <ProbeLine testing={testing} probe={probe} />

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
                        <Stat label='Temps de réponse' value={formatMs(database.lastElapsedMs)} />
                        <Stat label='Taille' value={formatBytes(database.sizeBytes)} />
                        <Stat label='Tables' value={formatCount(database.tableCount)} />
                        <Stat label='Version' value={database.serverVersion ?? '–'} />
                    </section>

                    {database.lastCheckAt === null && (
                        <p className={styles.hint}>
                            Ces chiffres sont vides : cette base n’a jamais été relevée. « Relever l’état » va les
                            chercher.
                        </p>
                    )}
                </>
            )}

            {/* Facultatif : sans indicateur, le bloc ne parle qu'à qui peut en poser un. */}
            {!expanded && (kpis.length > 0 || (canWrite && !database.foreign)) && (
                <section className={styles.panel}>
                    <header className={styles.panelHead}>
                        <h3 className={styles.panelTitle}>Indicateurs</h3>
                        <FeatureSettingsButton
                            scope={scope}
                            initialSection='kpis'
                            label='Gérer les indicateurs'
                            onGone={onGone}
                        />
                    </header>

                    {kpis.length === 0 ? (
                        <p className={styles.hint}>
                            Un indicateur garde sous les yeux le résultat d’une requête : commandes du jour, chiffre
                            d’affaires, stock le plus bas. « Gérer les indicateurs » en ajoute un.
                        </p>
                    ) : (
                        <div className={styles.kpiGrid}>
                            {kpis.map((kpi) => (
                                <div key={kpi.id} className={styles.kpiTile}>
                                    <span className={styles.statLabel}>{kpi.label}</span>
                                    <span className={styles.kpiValue}>
                                        {kpi.value === null ? '–' : formatKpiValue(kpi.value)}
                                        {kpi.value !== null && kpi.unit && (
                                            <span className={styles.kpiUnit}>{kpi.unit}</span>
                                        )}
                                    </span>
                                    {kpi.error ? (
                                        <span className={styles.kpiError}>{kpi.error}</span>
                                    ) : (
                                        <span className={styles.kpiMeta}>
                                            {kpi.measuredAt === null ? 'jamais mesuré' : formatAgo(kpi.measuredAt)}
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {kpis.length > 0 && !database.monitorEnabled && (
                        <p className={styles.hint}>
                            Mesurés à leur enregistrement et à chaque « Relever l’état ». Le relevé régulier (réglages,
                            Général) les tient à jour seul.
                        </p>
                    )}
                </section>
            )}

            {!expanded && (
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
                        {/* Hors du `canWrite` : un lecteur y voit les règles, et le
                            bouton se supprime seul sans section lisible. */}
                        <FeatureSettingsButton
                            scope={scope}
                            initialSection='alerts'
                            label='Gérer les alertes'
                            onGone={onGone}
                        />
                    </header>

                    {!database.monitorEnabled && alerts.length > 0 && (
                        <p className={styles.warn}>
                            La surveillance est éteinte : ces alertes ne sont <strong>pas évaluées</strong>. Activez le
                            relevé régulier dans les réglages de la base (Général) pour les rendre vivantes.
                        </p>
                    )}

                    {alerts.length === 0 && (
                        <p className={styles.hint}>
                            Aucune alerte. Une alerte compare le résultat de requêtes à des seuils (nombre d’erreurs de
                            la dernière heure, utilisateurs actifs, lignes en attente) et prévient sur les canaux de
                            l’espace.
                            {canWrite && ' « Gérer les alertes » en écrit une.'}
                        </p>
                    )}

                    <ul className={styles.alertList}>
                        {alerts.map((alert) => (
                            <li key={alert.id} className={alert.firing ? styles.alertRowOn : styles.alertRow}>
                                <div className={styles.alertEntry}>
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
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <TableExplorer
                databaseId={database.id}
                databaseName={database.name}
                autoLoad={canWrite && database.autoLoadTables && !database.planPaused}
                expanded={expanded}
                onExpandedChange={expand}
            />

            {!expanded && children}
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
