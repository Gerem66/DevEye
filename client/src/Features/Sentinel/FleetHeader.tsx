import type { DeviceSentinelState, FindingSeverity } from 'deveye-types';

import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';

import styles from './style.module.css';

/**
 * L'en-tête de la vue de flotte : où en est l'espace, et de quoi filtrer.
 *
 * Le score n'y figure pas — il est porté par le bouton de tête, dans la barre
 * latérale, qui sert à la fois de résumé et de retour à l'accueil de la feature.
 * L'afficher aux deux endroits faisait lire deux fois le même chiffre.
 */

const FILTERS: { id: FindingSeverity | null; label: string }[] = [
    { id: null, label: 'Tout' },
    { id: 'low', label: 'À surveiller et plus' },
    { id: 'high', label: 'Élevé et plus' },
    { id: 'critical', label: 'Critique' }
];

interface Props {
    devices: DeviceSentinelState[];
    minSeverity: FindingSeverity | null;
    onMinSeverity: (s: FindingSeverity | null) => void;
    showSettled: boolean;
    onShowSettled: (v: boolean) => void;
    onOpenNotifications: () => void;
}

export default function FleetHeader({
    devices,
    minSeverity,
    onMinSeverity,
    showSettled,
    onShowSettled,
    onOpenNotifications
}: Props) {
    const watched = devices.filter((d) => d.enabled).length;
    const learning = devices.filter((d) => d.enabled && d.learning).length;
    const totals = devices.reduce(
        (acc, d) => ({
            critical: acc.critical + d.open.critical,
            high: acc.high + d.open.high,
            low: acc.low + d.open.low + d.open.info
        }),
        { critical: 0, high: 0, low: 0 }
    );

    return (
        <header className={styles.header}>
            <div className={styles.headerTop}>
                <div>
                    <h2 className={styles.heading}>Sentinelle</h2>
                    <p className={styles.subheading}>
                        {watched === 0
                            ? `Aucun des ${devices.length} appareils de cet espace n’est surveillé.`
                            : `${watched} appareil${watched > 1 ? 's' : ''} surveillé${watched > 1 ? 's' : ''} sur ${devices.length}` +
                              (learning > 0 ? ` — ${learning} en apprentissage` : '')}
                    </p>
                </div>

                {/*
                 * Le score vit dans le bouton de tête, à gauche : le répéter ici
                 * faisait lire deux fois le même chiffre à deux endroits de
                 * l'écran. La place revient donc à l'action qui gouverne la
                 * flotte, qui n'en avait aucune.
                 */}
                <div className={styles.headerActions}>
                    <Button variant='ghost' icon='settings' onClick={onOpenNotifications}>
                        Notifications
                    </Button>
                </div>
            </div>

            <div className={styles.tallies}>
                <span className={`${styles.tally} ${styles.sevCritical}`}>
                    <span className={styles.tallyValue}>{totals.critical}</span> critique
                    {totals.critical > 1 ? 's' : ''}
                </span>
                <span className={`${styles.tally} ${styles.sevHigh}`}>
                    <span className={styles.tallyValue}>{totals.high}</span> élevé
                    {totals.high > 1 ? 's' : ''}
                </span>
                <span className={`${styles.tally} ${styles.sevLow}`}>
                    <span className={styles.tallyValue}>{totals.low}</span> à surveiller
                </span>
            </div>

            <div className={styles.filters}>
                {FILTERS.map((f) => (
                    <button
                        key={f.label}
                        type='button'
                        className={`${styles.filter} ${f.id === minSeverity ? styles.filterActive : ''}`}
                        onClick={() => onMinSeverity(f.id)}
                    >
                        {f.label}
                    </button>
                ))}
                <Checkbox checked={showSettled} onChange={onShowSettled} className={styles.filterCheck}>
                    Inclure acquittés et résolus
                </Checkbox>
            </div>
        </header>
    );
}
