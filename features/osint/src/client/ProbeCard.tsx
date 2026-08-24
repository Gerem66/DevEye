import { useState } from 'react';
import { motion } from 'framer-motion';
import { OSINT_PROBE_LABELS, type OsintProbeId, type OsintProbeResult, type OsintTone } from '../contracts/domain';

import { internalPivot } from './api';
import styles from './Osint.module.css';

/**
 * Le rendu **unique** d'un résultat de sonde.
 *
 * Toutes les sondes rendent la même forme (`OsintProbeResult`), donc ce
 * composant les affiche toutes — DNS, WHOIS, téléphone, registre du commerce.
 * C'est ce qui fait qu'ajouter une sonde côté serveur ne coûte pas une ligne
 * ici : elle apparaît dans la grille dès que le serveur la déclare.
 */

export type ProbeCardState =
    { kind: 'pending' } | { kind: 'done'; result: OsintProbeResult } | { kind: 'failed'; message: string };

interface Props {
    probe: OsintProbeId;
    state: ProbeCardState;
    onRetry: () => void;
    onPivot: (query: string) => void;
}

const TONE_CLASS: Record<OsintTone, string> = {
    neutral: styles.toneNeutral,
    good: styles.toneGood,
    warn: styles.toneWarn,
    bad: styles.toneBad
};

export function ProbeCard({ probe, state, onRetry, onPivot }: Props): React.ReactElement {
    const [rawOpen, setRawOpen] = useState(false);
    const label = OSINT_PROBE_LABELS[probe];

    return (
        <motion.section
            className={styles.card}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
        >
            <header className={styles.cardHead}>
                <h3 className={styles.cardTitle}>{state.kind === 'done' ? state.result.title : label}</h3>
                {state.kind === 'pending' && (
                    <span className={`icon icon-spinner ${styles.spinner}`} aria-label='En cours' />
                )}
                {state.kind === 'done' && state.result.tookMs > 0 && (
                    <span className={styles.timing}>{formatMs(state.result.tookMs)}</span>
                )}
            </header>

            {state.kind === 'pending' && (
                <div className={styles.skeleton} aria-hidden>
                    <span />
                    <span />
                    <span />
                </div>
            )}

            {state.kind === 'failed' && (
                <>
                    <p className={styles.errorText}>{state.message}</p>
                    <button type='button' className={styles.retry} onClick={onRetry}>
                        Réessayer
                    </button>
                </>
            )}

            {state.kind === 'done' && (
                <ProbeBody
                    result={state.result}
                    onPivot={onPivot}
                    onRetry={onRetry}
                    rawOpen={rawOpen}
                    setRawOpen={setRawOpen}
                />
            )}
        </motion.section>
    );
}

function ProbeBody({
    result,
    onPivot,
    onRetry,
    rawOpen,
    setRawOpen
}: {
    result: OsintProbeResult;
    onPivot: (q: string) => void;
    onRetry: () => void;
    rawOpen: boolean;
    setRawOpen: (v: boolean) => void;
}): React.ReactElement {
    return (
        <>
            {result.tags.length > 0 && (
                <div className={styles.tagRow}>
                    {result.tags.map((t, i) => (
                        <span key={`${t.label}-${i}`} className={`${styles.tag} ${TONE_CLASS[t.tone]}`}>
                            {t.label}
                        </span>
                    ))}
                </div>
            )}

            {result.summary && <p className={styles.summary}>{result.summary}</p>}

            {/* Le score et son barème. Montrer le calcul est le point : une note
                de fiabilité qu'on ne peut pas contredire ne vaut rien. */}
            {result.score && (
                <div className={`${styles.score} ${TONE_CLASS[result.score.tone]}`}>
                    <div className={styles.scoreHead}>
                        <span className={styles.scoreValue}>{result.score.value}</span>
                        <span className={styles.scoreLabel}>{result.score.label}</span>
                    </div>
                    <ul className={styles.signals}>
                        {result.score.signals.map((s, i) => (
                            <li key={i}>
                                <span className={s.delta >= 0 ? styles.deltaUp : styles.deltaDown}>
                                    {s.delta > 0 ? `+${s.delta}` : s.delta}
                                </span>
                                {s.label}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {result.fields.length > 0 && (
                <dl className={styles.fields}>
                    {result.fields.map((f, i) => (
                        <div key={`${f.label}-${i}`} className={styles.fieldRow}>
                            <dt>{f.label}</dt>
                            <dd className={f.mono ? styles.mono : undefined}>
                                {f.href ? (
                                    <a href={f.href} target='_blank' rel='noopener noreferrer'>
                                        {f.value}
                                    </a>
                                ) : (
                                    f.value
                                )}
                            </dd>
                        </div>
                    ))}
                </dl>
            )}

            {result.links.length > 0 && (
                <div className={styles.linkRow}>
                    {result.links.map((l, i) => {
                        const pivot = internalPivot(l.href);
                        return pivot ? (
                            <button
                                key={`${l.href}-${i}`}
                                type='button'
                                className={`${styles.chip} ${styles.chipPivot}`}
                                onClick={() => onPivot(pivot)}
                                title={`Rechercher ${pivot}`}
                            >
                                {l.label}
                            </button>
                        ) : (
                            <a
                                key={`${l.href}-${i}`}
                                className={styles.chip}
                                href={l.href}
                                target='_blank'
                                rel='noopener noreferrer'
                            >
                                {l.label}
                            </a>
                        );
                    })}
                </div>
            )}

            {result.status === 'empty' && result.fields.length === 0 && !result.summary && (
                <p className={styles.muted}>Aucun résultat.</p>
            )}

            <footer className={styles.cardFoot}>
                {result.raw && (
                    <button type='button' className={styles.rawToggle} onClick={() => setRawOpen(!rawOpen)}>
                        {rawOpen ? 'Masquer la réponse brute' : 'Réponse brute'}
                    </button>
                )}
                <button type='button' className={styles.rawToggle} onClick={onRetry}>
                    Relancer
                </button>
            </footer>

            {rawOpen && result.raw && <pre className={styles.raw}>{result.raw}</pre>}
        </>
    );
}

function formatMs(ms: number): string {
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
