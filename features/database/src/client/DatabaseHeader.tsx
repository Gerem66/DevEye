import type { ReactNode } from 'react';
import { Button, FeatureSettingsButton, openInfo } from 'deveye-sdk-client';
import type { Database } from '../contracts/domain';

import { ENGINE_LABELS, STATUS_META } from './format';
import styles from './style.module.css';

/** Ce que « Tester » et « Relever » font, et ce que « Relever » conserve. */
function explainInspect() {
    void openInfo({
        title: 'Tester, relever : quelle différence ?',
        width: 560,
        body: (
            <>
                <p>
                    <strong>Tester</strong> ouvre une connexion, lit la version du serveur et referme. Rien n’est
                    enregistré : c’est un « est-ce que ça répond ? », et son résultat s’affiche le temps qu’on le
                    regarde.
                </p>
                <p>
                    <strong>Relever</strong> fait davantage, en trois temps :
                </p>
                <ul>
                    <li>
                        il lit l’<strong>inventaire</strong> — version du serveur, taille totale de la base, nombre de
                        tables ;
                    </li>
                    <li>
                        il <strong>enregistre</strong> ces chiffres dans DevEye, avec la date et l’état joignable ou
                        non. Ce sont eux, et pas une lecture en direct, que montre le bandeau « État / Taille / Tables /
                        Version » juste en dessous : ils datent donc du dernier relevé ;
                    </li>
                    <li>
                        il <strong>évalue les alertes</strong> de cette base et envoie les notifications si l’une
                        bascule — exactement comme le fait le relevé périodique, puisque c’est le même code.
                    </li>
                </ul>
                <p>
                    Ce qu’il ne fait <strong>pas</strong> : aucune donnée de vos tables n’est copiée, ni téléchargée, ni
                    conservée. Seuls trois chiffres et une date entrent dans DevEye. Le contenu des tables ne se lit que
                    dans l’explorateur, à la demande, et n’est jamais gardé.
                </p>
                <p>
                    Relever à la main est utile même sans surveillance périodique : c’est ce qui permet de vérifier une
                    alerte qu’on vient d’écrire sur une base laissée au repos.
                </p>
            </>
        )
    });
}

interface DatabaseHeaderProps {
    database: Database;
    canWrite: boolean;
    busy: boolean;
    onTest: () => void;
    onInspect: () => void;
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
export function DatabaseHeader({
    database,
    canWrite,
    busy,
    onTest,
    onInspect,
    onOpenInFeature,
    onGone,
    before,
    after
}: DatabaseHeaderProps) {
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
                                via {database.access.kind === 'ssh' ? 'SSH' : 'SOCKS'} {database.access.host}
                            </span>
                        )}
                    </p>
                    {database.lastError && <p className={styles.error}>{database.lastError}</p>}
                </div>
            </div>
            {/* Rendue sans condition : le bouton de réglages est ouvert au lecteur. */}
            <div className={styles.actions}>
                {canWrite && (
                    <>
                        <Button variant='secondary' icon='refresh' onClick={onTest} disabled={busy}>
                            Tester
                        </Button>
                        <Button variant='secondary' icon='search' onClick={onInspect} disabled={busy}>
                            Relever l’état
                        </Button>
                        <button
                            type='button'
                            className={styles.infoButton}
                            aria-label='Que font « Tester » et « Relever l’état » ?'
                            title='Que font ces deux boutons ?'
                            onClick={explainInspect}
                        >
                            <span className='icon icon-info' />
                        </button>
                    </>
                )}
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
