import type { ReactNode } from 'react';
import { Button, FeatureSettingsButton, PlanPausedBadge } from 'deveye-sdk-client';
import type { Database } from '../contracts/domain';

import { ACCESS_VIA, ENGINE_LABELS, STATUS_META } from './format';
import styles from './style.module.css';

interface DatabaseHeaderProps {
    database: Database;
    /** Ouvrir cette base dans sa feature ; absent quand on y est déjà. */
    onOpenInFeature?: () => void;
    /**
     * Supprimée depuis ses réglages, la base n'est plus ici : quitter la fiche.
     * L'onglet d'un projet ne passe rien, sa liste suit d'elle-même.
     */
    onGone?: () => void;
    /** Posé avant l'identité (un retour à la liste, par exemple). */
    before?: ReactNode;
    /** Posé après les boutons (un « Délier », par exemple). */
    after?: ReactNode;
}

/**
 * L'en-tête d'une base, partagé entre la feature et l'onglet d'un projet ; ce
 * qui diffère entre par `before` et `after`.
 */
export function DatabaseHeader({ database, onOpenInFeature, onGone, before, after }: DatabaseHeaderProps) {
    const status = STATUS_META[database.status];

    return (
        <header className={styles.header}>
            <div className={styles.detailHead}>
                {before}
                <div className={styles.ident}>
                    <p className={styles.cardName}>
                        <span className={styles.statusDot} data-tone={status.tone} aria-hidden='true' />
                        {database.name}
                        {database.foreign && (
                            <span
                                className={styles.viaTag}
                                title='Cette base appartient à un autre espace qui la partage ici'
                            >
                                partagé
                            </span>
                        )}
                    </p>
                    <p className={styles.cardMeta}>
                        {ENGINE_LABELS[database.engine]} · {database.host}:{database.port}/{database.database}
                        {database.access.kind !== 'direct' && (
                            <span className={styles.viaTag}>
                                via {ACCESS_VIA[database.access.kind]}
                                {database.access.kind !== 'device' && ` ${database.access.host}`}
                            </span>
                        )}
                        {database.planPaused && (
                            <>
                                {' '}
                                <PlanPausedBadge />
                            </>
                        )}
                    </p>
                    {database.lastError && <p className={styles.error}>{database.lastError}</p>}
                </div>
            </div>
            {/* Rendue sans condition : le bouton de réglages est ouvert au lecteur. */}
            <div className={styles.actions}>
                {/* Les réglages de cette base, sa connexion et sa suppression
                    comprises (onglet Général). Le bouton se garde de lui-même,
                    sans section accessible il ne s'affiche pas. */}
                <FeatureSettingsButton
                    scope={{
                        kind: 'item',
                        feature: 'database',
                        itemId: String(database.id),
                        itemLabel: database.name
                    }}
                    onGone={onGone}
                />
                {/* Avant-dernier, avant `after` : le même ordre dans les trois
                    onglets d'un projet. */}
                {onOpenInFeature && (
                    <Button variant='secondary' icon='chevrons-right' onClick={onOpenInFeature}>
                        Ouvrir la Base de données
                    </Button>
                )}
                {after}
            </div>
        </header>
    );
}

export default DatabaseHeader;
