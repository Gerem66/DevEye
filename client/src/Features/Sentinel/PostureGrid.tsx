import { SENTINEL_RULES, type DevicePosture, type PostureStatus } from 'deveye-types';

import styles from './style.module.css';

/**
 * La posture d'un appareil, contrôle par contrôle.
 *
 * Quatre états et non deux, parce que la nuance porte tout le sens :
 *
 * - **conforme** / **à corriger** : la sonde a répondu ;
 * - **non mesuré** : elle n'a rien pu dire. Ce n'est **pas** un succès, et
 *   l'afficher en vert donnerait une assurance que rien ne soutient ;
 * - **sans objet** : le contrôle ne s'applique pas à cette plateforme (SIP hors
 *   macOS). Le confondre avec « non mesuré » ferait chercher une sonde
 *   défaillante qui n'a jamais eu lieu d'exister.
 *
 * Le score ne compte que les deux premiers — voir `posturize` côté serveur.
 */

const STATUS_LABEL: Record<PostureStatus, string> = {
    ok: 'conforme',
    fail: 'à corriger',
    unknown: 'non mesuré',
    not_applicable: 'sans objet'
};

function statusClass(status: PostureStatus): string {
    switch (status) {
        case 'ok':
            return styles.postureOk;
        case 'fail':
            return styles.postureFail;
        case 'unknown':
            return styles.postureUnknown;
        default:
            return styles.postureNa;
    }
}

export default function PostureGrid({ posture }: { posture: DevicePosture }) {
    return (
        <div className={styles.posture}>
            <header className={styles.postureHead}>
                <div>
                    <h3 className={styles.postureTitle}>Posture — {posture.deviceName}</h3>
                    <p className={styles.postureHint}>
                        Le score ne porte que sur les contrôles concluants : une sonde muette ne compte ni en bien ni en
                        mal.
                    </p>
                </div>
                <span
                    className={`${styles.postureScore} ${
                        posture.score === null
                            ? styles.postureUnknown
                            : posture.score >= 80
                              ? styles.postureOk
                              : posture.score >= 50
                                ? styles.postureWarn
                                : styles.postureFail
                    }`}
                >
                    {posture.score === null ? '—' : `${posture.score}`}
                </span>
            </header>

            <ul className={styles.postureList}>
                {posture.checks.map((check) => (
                    <li key={check.rule} className={styles.postureRow}>
                        <span className={`${styles.postureDot} ${statusClass(check.status)}`} />
                        <span className={styles.postureLabel}>{check.label}</span>
                        <span className={`${styles.postureStatus} ${statusClass(check.status)}`}>
                            {check.detail ?? STATUS_LABEL[check.status]}
                        </span>
                        {check.status === 'fail' && (
                            <span className={styles.postureFix}>{SENTINEL_RULES[check.rule].remediation}</span>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}
