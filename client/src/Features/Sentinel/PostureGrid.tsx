import { SENTINEL_RULES, type DevicePosture, type PostureStatus, type RuleProbe } from '@deveye/types';

import styles from './style.module.css';

/**
 * La posture d'une machine, contrôle par contrôle.
 *
 * Quatre états et non deux, parce que la nuance porte tout le sens :
 *
 * - **conforme** / **à corriger** : la sonde a répondu ;
 * - **non mesuré** : elle n'a rien pu dire. Ce n'est pas un succès, et l'afficher
 *   en vert donnerait une assurance que rien ne soutient ;
 * - **sans objet** : le contrôle ne s'applique pas à cette plateforme (SIP hors
 *   macOS). Le confondre avec « non mesuré » ferait chercher une sonde
 *   défaillante qui n'a jamais eu lieu d'exister.
 *
 * Les contrôles à corriger remontent en tête : c'est la seule question qu'on
 * pose à cet écran.
 */

const STATUS_LABEL: Record<PostureStatus, string> = {
    ok: 'conforme',
    fail: 'à corriger',
    unknown: 'non mesuré',
    not_applicable: 'sans objet'
};

/** Poids de tri : ce qui appelle une action d'abord, ce qui n'en appelle pas ensuite. */
const STATUS_RANK: Record<PostureStatus, number> = {
    fail: 0,
    unknown: 1,
    ok: 2,
    not_applicable: 3
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

interface Props {
    posture: DevicePosture;
    /** Ce que l'agent sait relever, pour expliquer un « non mesuré » collectif. */
    probes: RuleProbe[];
}

export default function PostureGrid({ posture, probes }: Props) {
    const checks = [...posture.checks].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
    const failing = checks.filter((c) => c.status === 'fail').length;
    const unknown = checks.filter((c) => c.status === 'unknown').length;
    const hasExtended = probes.includes('posture');

    return (
        <div className={styles.posture}>
            <p className={styles.sectionHint}>
                {failing === 0 && unknown === 0
                    ? 'Tous les contrôles concluants sont conformes.'
                    : `${failing} à corriger${unknown > 0 ? `, ${unknown} non mesuré${unknown > 1 ? 's' : ''}` : ''}. Le score ne compte que les contrôles concluants : une sonde muette ne pèse ni en bien ni en mal.`}
                {!hasExtended && unknown > 0 && ' L’agent de cette machine ne remonte pas encore la posture étendue.'}
            </p>

            <ul className={styles.postureList}>
                {checks.map((check) => (
                    <li
                        key={check.rule}
                        className={`${styles.postureRow} ${check.status === 'fail' ? styles.postureRowFail : ''}`}
                    >
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
