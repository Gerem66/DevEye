import type { FeedbackSnapshot } from '@deveye/types';

import styles from './style.module.css';

/**
 * Le rapport technique d'un bug, mis en pages plutôt qu'en JSON : c'est là que
 * se gagne le temps de diagnostic. Ce qui saute aux yeux d'abord : une requête
 * en échec, une erreur, un client resté sur une version que le serveur a
 * dépassée.
 */

/** Un instant relatif, dit comme on le lit : « il y a 3 s ». */
function ago(ms: number): string {
    if (ms < 1000) return 'à l’instant';
    const s = Math.round(ms / 1000);
    if (s < 60) return `il y a ${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `il y a ${m} min`;
    return `il y a ${Math.round(m / 60)} h`;
}

function yesNo(value: boolean | null): string {
    if (value === null) return 'inconnu';
    return value ? 'oui' : 'non';
}

function Field({ label, value }: { label: string; value: string }) {
    return (
        <div className={styles.field}>
            <span className={styles.fieldLabel}>{label}</span>
            <span className={styles.fieldValue}>{value}</span>
        </div>
    );
}

export interface SnapshotViewProps {
    snapshot: FeedbackSnapshot;
    /** Version du serveur à l'envoi : un écart avec le client explique beaucoup. */
    serverVersion: string;
}

export function SnapshotView({ snapshot, serverVersion }: SnapshotViewProps) {
    const { browser, viewport, app, requests, errors, views } = snapshot;
    const stale = app.clientVersion !== serverVersion;
    const failed = requests.filter((r) => r.outcome !== 'ok').length;

    return (
        <div className={styles.snapshot}>
            <section className={styles.section}>
                <h4 className={styles.sectionTitle}>Application</h4>
                <div className={styles.fields}>
                    <Field
                        label='Version du client'
                        value={stale ? `${app.clientVersion} (serveur : ${serverVersion})` : app.clientVersion}
                    />
                    <Field label='Vue ouverte' value={app.view ?? 'accueil'} />
                    <Field label='Espace' value={app.workspaceId === null ? 'aucun' : `#${app.workspaceId}`} />
                    <Field label='Connexion' value={app.connection} />
                    <Field label='Onglet ouvert depuis' value={`${app.sessionAgeSeconds} s`} />
                    <Field label='Chemin' value={app.path} />
                </div>
                {stale && (
                    <p className={styles.warn}>
                        Cet onglet tournait sur une version antérieure à celle du serveur : un rechargement peut suffire
                        à faire disparaître le problème.
                    </p>
                )}
            </section>

            <section className={styles.section}>
                <h4 className={styles.sectionTitle}>Navigateur</h4>
                <div className={styles.fields}>
                    <Field
                        label='Navigateur'
                        value={browser.name ? `${browser.name} ${browser.version ?? ''}`.trim() : 'non déclaré'}
                    />
                    <Field label='Plateforme' value={browser.platform ?? 'inconnue'} />
                    <Field label='Mobile' value={yesNo(browser.mobile)} />
                    <Field label='Langue' value={browser.language} />
                    <Field label='Fuseau' value={browser.timezone} />
                    <Field label='Cœurs' value={browser.cores === null ? 'inconnu' : String(browser.cores)} />
                    <Field label='Mémoire' value={browser.memoryGb === null ? 'inconnue' : `${browser.memoryGb} Gio`} />
                    <Field label='En ligne' value={yesNo(browser.online)} />
                </div>
                <p className={styles.userAgent}>{browser.userAgent}</p>
            </section>

            <section className={styles.section}>
                <h4 className={styles.sectionTitle}>Fenêtre</h4>
                <div className={styles.fields}>
                    <Field label='Taille' value={`${viewport.width} × ${viewport.height}`} />
                    <Field label='Densité' value={`${viewport.pixelRatio}×`} />
                    <Field label='Thème du système' value={viewport.colorScheme === 'light' ? 'clair' : 'sombre'} />
                    <Field label='Mouvement réduit' value={yesNo(viewport.reducedMotion)} />
                </div>
            </section>

            <section className={styles.section}>
                <h4 className={styles.sectionTitle}>
                    Erreurs récentes {errors.length > 0 && <span className={styles.count}>{errors.length}</span>}
                </h4>
                {errors.length === 0 ? (
                    <p className={styles.none}>Aucune erreur n’a été capturée.</p>
                ) : (
                    <ul className={styles.errorList}>
                        {errors.map((e, i) => (
                            <li key={i} className={styles.errorItem}>
                                <div className={styles.errorHead}>
                                    <span className={styles.errorKind}>
                                        {e.source === 'rejection' ? 'Promesse rejetée' : 'Erreur'}
                                    </span>
                                    <span className={styles.dim}>{ago(e.ago)}</span>
                                </div>
                                <p className={styles.errorMessage}>{e.message}</p>
                                {e.origin && <p className={styles.dim}>{e.origin}</p>}
                                {e.stack && <pre className={styles.stack}>{e.stack}</pre>}
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className={styles.section}>
                <h4 className={styles.sectionTitle}>
                    Dernières requêtes{' '}
                    {failed > 0 && <span className={`${styles.count} ${styles.countBad}`}>{failed} en échec</span>}
                </h4>
                {requests.length === 0 ? (
                    <p className={styles.none}>Aucune requête n’a été enregistrée.</p>
                ) : (
                    <div className={styles.traceWrap}>
                        <table className={styles.traceTable}>
                            <thead>
                                <tr>
                                    <th>Quand</th>
                                    <th>Canal</th>
                                    <th>Cible</th>
                                    <th>Durée</th>
                                    <th>Issue</th>
                                </tr>
                            </thead>
                            <tbody>
                                {requests.map((r, i) => (
                                    <tr key={i} className={r.outcome === 'ok' ? undefined : styles.rowBad}>
                                        <td className={styles.dim}>{ago(r.ago)}</td>
                                        <td>{r.channel === 'ws' ? 'Commande' : 'HTTP'}</td>
                                        <td className={styles.mono}>{r.target}</td>
                                        <td>{r.durationMs} ms</td>
                                        <td className={styles.mono}>{r.outcome}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            <section className={styles.section}>
                <h4 className={styles.sectionTitle}>Vues traversées</h4>
                {views.length === 0 ? (
                    <p className={styles.none}>Aucune vue n’a été ouverte.</p>
                ) : (
                    <ol className={styles.viewList}>
                        {views.map((v, i) => (
                            <li key={i}>
                                <span className={styles.mono}>{v.view}</span>{' '}
                                <span className={styles.dim}>{ago(v.ago)}</span>
                            </li>
                        ))}
                    </ol>
                )}
            </section>
        </div>
    );
}

export default SnapshotView;
