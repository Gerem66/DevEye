import { CHANGELOG, type ChangeKind, type ChangelogEntry } from './changelog';
import styles from './AboutContent.module.css';

const KIND_LABEL: Record<ChangeKind, string> = {
    added: 'Nouveau',
    improved: 'Amélioré',
    fixed: 'Corrigé',
    removed: 'Retiré'
};

const KIND_CLASS: Record<ChangeKind, string> = {
    added: styles.kindAdded,
    improved: styles.kindImproved,
    fixed: styles.kindFixed,
    removed: styles.kindRemoved
};

/** « 29 septembre 2026 », lu en UTC : une date sans heure ne doit pas glisser d'un jour selon le fuseau. */
export function releaseDate(date: string): string {
    return new Date(`${date}T00:00:00Z`).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    });
}

export function ChangeList({ changes }: { changes: ChangelogEntry['changes'] }) {
    return (
        <ul className={styles.changes}>
            {changes.map((change) => (
                <li key={change.text} className={styles.change}>
                    <span className={`${styles.kind} ${KIND_CLASS[change.kind]}`}>{KIND_LABEL[change.kind]}</span>
                    <span>{change.text}</span>
                </li>
            ))}
        </ul>
    );
}

export default function ChangelogTab() {
    return (
        <ol className={styles.releases}>
            {CHANGELOG.map((entry) => (
                <li key={entry.version} className={styles.release}>
                    <p className={styles.releaseHead}>
                        <strong>Version {entry.version}</strong>
                        <span>{releaseDate(entry.date)}</span>
                    </p>
                    <ChangeList changes={entry.changes} />
                </li>
            ))}
        </ol>
    );
}
