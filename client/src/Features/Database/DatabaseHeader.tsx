import type { ReactNode } from 'react';
import type { Database } from 'deveye-types';
import { Button } from '@/Components';
import { openInfo } from '@/Components/InfoPopup';
import { ENGINE_LABELS, STATUS_META } from './format';
import styles from './style.module.css';

/**
 * Ce que « Relever » fait vraiment.
 *
 * La question s'est posée telle quelle : est-ce que ça copie la base ? est-ce
 * que ça la teste ? est-ce que ça évalue les alertes ? Le mot seul ne pouvait
 * pas y répondre, et deux boutons voisins qui joignent tous deux le serveur sans
 * dire en quoi ils diffèrent laissaient la question ouverte.
 */
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
    onEdit: () => void;
    /**
     * Ouvrir cette base dans la feature « Bases de données ».
     *
     * Absent quand on y est déjà : dans sa propre feature, le nom n'a nulle part
     * où mener. Présent dans l'onglet d'un projet, où la base est montrée en
     * entier alors que tout ce qui la concerne vraiment (ses réglages, ses
     * projets, ses voisines) vit ailleurs.
     *
     * Rendu comme un **bouton de la barre d'actions**, et non plus en rendant le
     * titre cliquable. Un titre qui navigue ne s'annonce pas : rien ne le
     * distingue d'un intitulé, et il fallait le survoler pour le découvrir. Les
     * trois onglets d'un projet portent désormais la même barre, dans le même
     * ordre : actions de la feature, « Ouvrir… », puis « Délier ».
     */
    onOpenInFeature?: () => void;
    /** Posé avant l'identité — un retour à la liste, par exemple. */
    before?: ReactNode;
    /** Posé après les boutons — un « Délier », par exemple. */
    after?: ReactNode;
}

/**
 * L'en-tête d'une base : ce qu'elle est, et ce qu'on peut lui faire.
 *
 * Partagé entre la feature et l'onglet d'un projet, comme le contenu qu'il
 * surmonte. Ce qui diffère d'un contexte à l'autre entre par `before` et
 * `after` : la feature met un retour à la liste, l'onglet d'un projet un
 * « Délier » — le reste est identique, et doit le rester.
 */
export function DatabaseHeader({
    database,
    canWrite,
    busy,
    onTest,
    onInspect,
    onEdit,
    onOpenInFeature,
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
            {/* La barre est rendue dès qu'elle a quelque chose à porter, et non
                sous la seule condition d'écriture : « Ouvrir… » est une
                navigation, un lecteur y a droit. */}
            {(canWrite || onOpenInFeature || after) && (
                <div className={styles.actions}>
                    {canWrite && (
                        <>
                            <Button variant='secondary' icon='refresh' onClick={onTest} disabled={busy}>
                                Tester
                            </Button>
                            <Button variant='secondary' icon='search' onClick={onInspect} disabled={busy}>
                                Relever l’état
                            </Button>
                            {/* Deux boutons voisins joignent le serveur ; celui-ci dit
                        en quoi ils diffèrent, et ce que « relever » garde. */}
                            <button
                                type='button'
                                className={styles.infoButton}
                                aria-label='Que font « Tester » et « Relever l’état » ?'
                                title='Que font ces deux boutons ?'
                                onClick={explainInspect}
                            >
                                <span className='icon icon-info' />
                            </button>
                            <Button variant='secondary' icon='edit' onClick={onEdit} disabled={busy}>
                                Modifier
                            </Button>
                        </>
                    )}
                    {/* Toujours l'avant-dernier : les trois onglets d'un projet
                        rangent leur barre dans le même ordre, actions de la
                        feature puis « Ouvrir… » puis « Délier ». */}
                    {onOpenInFeature && (
                        <Button variant='secondary' icon='chevrons-right' onClick={onOpenInFeature}>
                            Ouvrir la Base de données
                        </Button>
                    )}
                    {after}
                </div>
            )}
        </header>
    );
}

export default DatabaseHeader;
