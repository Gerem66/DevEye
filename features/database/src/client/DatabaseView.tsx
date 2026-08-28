import { useCallback, useState, type ReactNode } from 'react';
import { FeatureSettingsButton } from 'deveye-sdk-client';
import type { Database, DatabaseAlert, DatabaseProbe } from '../contracts/domain';

import { ProbeLine } from './ProbeLine';
import { TableExplorer } from './TableExplorer';
import { formatAgo, formatBytes, formatCount, formatInterval, formatMs, STATUS_META } from './format';
import styles from './style.module.css';

interface DatabaseViewProps {
    database: Database;
    alerts: DatabaseAlert[];
    canWrite: boolean;
    /** Un essai de connexion est en cours (« Tester », pas « Relever »). */
    testing: boolean;
    /** Le dernier essai de connexion, s'il y en a eu un dans cette vue. */
    probe: DatabaseProbe | null;
    /**
     * L'explorateur passe (ou sort) du plein écran.
     *
     * Remonté parce que l'appelant possède ce que ce mode doit effacer — son
     * en-tête — et la racine dont le panneau agrandi tire sa hauteur.
     */
    onExpandChange?: (expanded: boolean) => void;
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
 *
 * ## Les alertes : un état, pas un formulaire
 *
 * Le bloc « Alertes » montre ce que les règles ont mesuré (franchie ou non,
 * dernières valeurs, erreur), et rien ne s'y écrit. Leur écriture (créer,
 * modifier, supprimer) est un réglage de la base, et vit donc dans l'onglet
 * Alertes de sa coquille de réglages, derrière le bouton commun posé dans
 * l'en-tête du bloc. C'était la dette de la coquille de cette feature : un
 * dialogue artisanal derrière son propre « Nouvelle alerte », dans le corps de
 * la fiche.
 *
 * ## Le mode agrandi
 *
 * L'explorateur peut prendre toute la place : tout ce qui décrit la **base** —
 * son état, ses alertes, ses projets — s'efface alors, pour ne plus laisser à
 * l'écran que la table qu'on regarde. C'est l'état qui remonte à l'appelant, lui
 * seul pouvant effacer l'en-tête et donner sa hauteur à la racine.
 */
export function DatabaseView({
    database,
    alerts,
    canWrite,
    testing,
    probe,
    onExpandChange,
    children
}: DatabaseViewProps) {
    const [expanded, setExpanded] = useState(false);
    const status = STATUS_META[database.status];

    // Stable : l'explorateur s'en sert dans un effet de remise à zéro, qui
    // rejouerait à chaque rendu si la fonction changeait d'identité.
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
                    {/* Le résultat d'un essai à la demande, à part de l'état
                        enregistré : l'un dit « en ce moment », l'autre « au
                        dernier relevé ». */}
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
                        {/* Le temps qu'a mis le dernier relevé à aboutir. C'est
                            le premier signe d'une base qui se dégrade, bien avant
                            qu'elle devienne injoignable — et il n'apparaissait
                            jusqu'ici que dans un essai, donc jamais deux fois de
                            suite au même endroit. */}
                        <Stat label='Temps de réponse' value={formatMs(database.lastElapsedMs)} />
                        <Stat label='Taille' value={formatBytes(database.sizeBytes)} />
                        <Stat label='Tables' value={formatCount(database.tableCount)} />
                        <Stat label='Version' value={database.serverVersion ?? '—'} />
                    </section>

                    {/* Dire d'où viennent ces chiffres, sans quoi on les croit lus
                        à l'instant — alors qu'ils datent du dernier relevé, lequel
                        peut n'avoir jamais eu lieu. */}
                    {database.lastCheckAt === null && (
                        <p className={styles.hint}>
                            Ces chiffres sont vides : cette base n’a jamais été relevée. « Relever l’état » va les
                            chercher.
                        </p>
                    )}
                </>
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
                        {/* Le bouton commun, ouvert sur l'onglet Alertes : c'est
                            là que les règles se créent et se corrigent. Hors du
                            `canWrite` : un lecteur y voit les règles à défaut de
                            les changer, et le bouton se supprime seul quand
                            aucune section n'est lisible. */}
                        <FeatureSettingsButton
                            scope={{
                                kind: 'item',
                                feature: 'database',
                                itemId: database.id,
                                itemLabel: database.name
                            }}
                            initialSection='alerts'
                            label='Gérer les alertes'
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
                            Aucune alerte. Une alerte compare le résultat de requêtes à des seuils — nombre d’erreurs de
                            la dernière heure, utilisateurs actifs, lignes en attente — et prévient sur les canaux de
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
                                            ` · ${alert.lastValues.map((v) => (v === null ? '—' : v)).join(' / ')}`}
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
                autoLoad={canWrite && database.autoLoadTables}
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
