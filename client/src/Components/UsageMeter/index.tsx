import { formatBytesFr } from '@/format';
import { openAccountView } from '@/stores/accountView';
import { useWorkspacePermissions } from '@/stores/workspace';
import styles from './UsageMeter.module.css';

/** À partir d'où la jauge prévient, puis alarme. */
const WARN_AT = 0.8;
const FULL_AT = 0.95;

interface UsageMeterProps {
    used: number;
    /** `null` : sans limite, la jauge ne dit que l'usage. */
    limit: number | null;
    /** Ce que la jauge mesure, en tête de l'info-bulle : « Espace utilisé par CloudSync ». */
    label: string;
    /** Ce qui est compté, en une phrase, à la suite. */
    explain?: string;
    /** Octets par défaut. */
    format?: (value: number) => string;
    /** Le mot après l'usage seul, sans limite : « utilisés ». */
    usedWord?: string;
}

/**
 * La jauge discrète d'un quota dans l'en-tête d'une fonctionnalité : le même
 * compte que le refus. Pour le propriétaire de l'espace, elle mène aux offres.
 */
export function UsageMeter({
    used,
    limit,
    label,
    explain,
    format = formatBytesFr,
    usedWord = 'utilisés'
}: UsageMeterProps) {
    const { isOwner } = useWorkspacePermissions();
    const suffix = explain ? ` ${explain}` : '';

    if (limit === null) {
        return (
            <span className={styles.meter} title={`${label}.${suffix}`}>
                <span className={styles.text}>
                    {format(used)} {usedWord}
                </span>
            </span>
        );
    }

    const ratio = limit > 0 ? Math.min(1, used / limit) : 1;
    const tone = ratio >= FULL_AT ? 'danger' : ratio >= WARN_AT ? 'warning' : 'normal';
    const text = `${format(used)} sur ${format(limit)}`;
    const title =
        `${label} : ${text}.${suffix}` +
        (isOwner ? ' Cliquez pour voir les offres.' : ' La limite est celle de l’offre du propriétaire de l’espace.');
    const content = (
        <>
            <span className={styles.text}>{text}</span>
            <span
                className={styles.bar}
                role='meter'
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={limit}
                aria-valuenow={Math.min(used, limit)}
                aria-valuetext={text}
            >
                <span className={styles.fill} data-tone={tone} style={{ width: `${ratio * 100}%` }} />
            </span>
        </>
    );

    return isOwner ? (
        <button type='button' className={styles.meter} title={title} onClick={() => openAccountView()}>
            {content}
        </button>
    ) : (
        <span className={styles.meter} title={title}>
            {content}
        </span>
    );
}
