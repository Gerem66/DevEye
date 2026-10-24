import { ErrorNote, StatusBadge, formatBytesFr, useResource, useSubView } from 'deveye-sdk-client';

import { MODERATION_REASON_LABELS, type Hit } from '../contracts/domain';
import { api } from './api';
import { featureName, momentLabel, plural, shortHash } from './format';
import styles from './style.module.css';

const LIMIT = 200;

/**
 * Ce que les règles ont arrêté : le fichier, l'élément qui le portait, la
 * fonctionnalité, la règle et quand. Ce n'est pas une file de décisions, la
 * fonctionnalité qui a arrêté le fichier a déjà fait son travail ; c'est ce
 * qu'il faut lire pour savoir si une règle sert, ou si elle arrête à tort.
 */
export default function Hits() {
    useSubView('detections');
    const hits = useResource(
        'x-moderation.hits',
        () => api.send('x-moderation.hits', { limit: LIMIT }),
        'Les détections n’ont pas pu être lues.'
    );
    const list = hits.data?.hits ?? null;

    return (
        <div className={styles.tab}>
            <p className={styles.lead}>
                Les derniers fichiers arrêtés par une règle, les plus récents en tête. Un même fichier arrêté plusieurs
                fois au même endroit tient sur une ligne, qui dit combien.
            </p>
            <section>
                <div className={styles.sectionHead}>
                    <h3 className={styles.sectionTitle}>
                        {list === null
                            ? 'Détections'
                            : list.length >= LIMIT
                              ? `${LIMIT} dernières détections`
                              : plural(list.length, 'détection', 'détections')}
                    </h3>
                </div>
                {hits.error !== null ? (
                    <ErrorNote note={hits.error} />
                ) : list === null ? (
                    <p className={styles.empty}>Chargement…</p>
                ) : list.length === 0 ? (
                    <p className={styles.empty}>Aucune détection pour l’instant.</p>
                ) : (
                    <ul className={styles.list}>
                        {list.map((hit) => (
                            <HitCard key={hit.id} hit={hit} />
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}

function HitCard({ hit }: { hit: Hit }) {
    const origin = [
        hit.workspaceId === null ? null : `espace n° ${hit.workspaceId}`,
        hit.userId === null ? null : `compte n° ${hit.userId}`
    ].filter((part): part is string => part !== null);
    return (
        <li className={styles.card}>
            <div className={styles.cardHead}>
                <span className={styles.cardTitle}>
                    <span className={styles.pattern}>{hit.name}</span>
                    <StatusBadge tone='warning' dot={false}>
                        {MODERATION_REASON_LABELS[hit.reason]}
                    </StatusBadge>
                    {hit.count > 1 && (
                        <StatusBadge tone='neutral' dot={false}>
                            {plural(hit.count, 'fois', 'fois')}
                        </StatusBadge>
                    )}
                </span>
                <span className={styles.cardMeta}>
                    {featureName(hit.feature)}
                    {hit.context.length > 0 ? ` · ${hit.context}` : ''} · {momentLabel(hit.lastSeen)}
                </span>
            </div>
            <p className={styles.cardText}>
                {hit.kind === 'fingerprint' ? 'Empreinte interdite' : 'Nom interdit'} : {hit.label}
                {hit.ruleId === null ? ' (règle retirée depuis)' : ''}
            </p>
            <p className={styles.cardMeta}>
                {[
                    hit.sha256 === null ? null : `SHA-256 ${shortHash(hit.sha256)}`,
                    hit.size === null ? null : formatBytesFr(hit.size),
                    hit.count > 1 ? `vu la première fois ${momentLabel(hit.firstSeen)}` : null,
                    origin.length > 0 ? origin.join(', ') : null
                ]
                    .filter((part): part is string => part !== null)
                    .join(' · ')}
            </p>
        </li>
    );
}
