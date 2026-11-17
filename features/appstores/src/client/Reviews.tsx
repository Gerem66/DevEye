import { useEffect, useMemo, useRef, useState } from 'react';
import {
    Button,
    Checkbox,
    ErrorNote,
    errorNote,
    invalidate,
    SearchSelect,
    StatusBadge,
    useResource,
    useResourceVersion,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import {
    APPSTORES_REVIEW_PAGE_MAX,
    type AppStore,
    type AppStoresApp,
    type AppStoresRange,
    type AppStoresReview,
    type AppStoresSource
} from '../contracts/domain';

import { api } from './api';
import CapabilityNote from './CapabilityNote';
import { countryName, formatDate, STORE_ICONS, STORE_LABELS, STORE_ORDER } from './format';
import ReplyDialog from './ReplyDialog';
import StarBars, { Stars } from './Stats/StarBars';
import styles from './style.module.css';

const PAGE = 25;

const RATING_OPTIONS = [
    { value: '', label: 'Toutes les notes' },
    ...[5, 4, 3, 2, 1].map((stars) => ({ value: String(stars), label: `${stars} étoile${stars > 1 ? 's' : ''}` }))
];

interface ReviewsProps {
    app: AppStoresApp;
    sources: readonly AppStoresSource[] | null;
    /** La période, commune aux onglets de la fiche. */
    range: AppStoresRange;
    /** Le store choisi dans la fiche, `null` pour les deux. */
    store: AppStore | null;
    canWrite: boolean;
}

/**
 * Les avis d'une app, du plus récent au plus ancien, et leur répartition sur
 * la période. Répondre est une écriture, et ne part que de l'espace de l'app :
 * c'est là que vit la clé qui publie.
 */
export function Reviews({ app, store, sources, canWrite, range }: ReviewsProps) {
    const stores = STORE_ORDER.filter((store) => app.listings.some((listing) => listing.store === store));
    const linked = stores.length > 0;

    const [rating, setRating] = useState('');
    const [unanswered, setUnanswered] = useState(false);
    const [reviews, setReviews] = useState<AppStoresReview[] | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [replying, setReplying] = useState<AppStoresReview | null>(null);
    const version = useResourceVersion('appstores.reviews');

    const stats = useResource(
        'appstores.stats',
        () =>
            linked
                ? api
                      .send('appstores.stats', { appId: app.id, range, ...(store ? { store } : {}) })
                      .then((res) => res.stats)
                : Promise.resolve(null),
        'La répartition des avis n’a pas pu être lue.',
        [app.id, range, store, linked]
    );

    const filter = useMemo(
        () => ({
            appId: app.id,
            ...(store ? { store } : {}),
            ...(rating ? { rating: Number(rating) } : {}),
            ...(unanswered ? { unanswered: true } : {})
        }),
        [app.id, store, rating, unanswered]
    );
    /** Les filtres de la liste affichée : une suite qui arrive après un changement de filtre ne s'y ajoute pas. */
    const [loadedFor, setLoadedFor] = useState<typeof filter | null>(null);
    const current = useRef(filter);
    current.current = filter;
    /** Une relecture rend autant d'avis que l'écran en montre, pas seulement la première page. */
    const shown = useRef(PAGE);

    useEffect(() => {
        shown.current = PAGE;
    }, [filter]);

    useEffect(() => {
        if (!linked) return;
        let alive = true;
        api.send('appstores.listReviews', { ...filter, limit: Math.min(APPSTORES_REVIEW_PAGE_MAX, shown.current) })
            .then((res) => {
                if (!alive) return;
                setReviews(res.reviews);
                setHasMore(res.hasMore);
                setLoadedFor(filter);
                setError(null);
            })
            .catch((e: unknown) => {
                if (alive) setError(errorNote(e, 'Les avis n’ont pas pu être lus.'));
            });
        return () => {
            alive = false;
        };
    }, [filter, version, linked]);

    const loadMore = async () => {
        const last = reviews?.[reviews.length - 1];
        if (!last || loadingMore) return;
        const asked = filter;
        setLoadingMore(true);
        try {
            const res = await api.send('appstores.listReviews', {
                ...asked,
                before: { createdAt: last.createdAt, id: last.id },
                limit: PAGE
            });
            if (current.current !== asked) return;
            setReviews((prev) => [...(prev ?? []), ...res.reviews]);
            setHasMore(res.hasMore);
            shown.current = (reviews?.length ?? 0) + res.reviews.length;
        } catch (e) {
            setError(errorNote(e, 'Les avis suivants n’ont pas pu être lus.'));
        } finally {
            setLoadingMore(false);
        }
    };

    if (!linked) {
        return (
            <p className={styles.blockEmpty}>
                Cette app n’est reliée à aucun store : ses avis arriveront dès qu’une fiche sera reliée.
            </p>
        );
    }

    /** Répondre vit chez l'app, avec sa clé : jamais depuis un espace qui ne fait que la voir. */
    const canReply = canWrite && !app.foreign;
    const filtered = store !== null || rating !== '' || unanswered;
    const stale = loadedFor !== filter;

    return (
        <>
            <section className={styles.block}>
                <header className={styles.blockHead}>
                    <h3 className={styles.blockTitle}>Répartition des avis reçus sur la période</h3>
                </header>
                <ErrorNote note={stats.error} />
                {stats.data ? (
                    <div className={styles.measure} data-stale={stats.data.range !== range ? '' : undefined}>
                        <StarBars counts={stats.data.reviewStars} />
                    </div>
                ) : (
                    !stats.error && <p className={styles.blockEmpty}>Chargement…</p>
                )}
                <p className={styles.blockHint}>
                    Aucun store ne donne la répartition de toutes les notes : celle-ci ne compte que les avis écrits,
                    reçus sur la période.
                </p>
            </section>

            <section className={styles.block}>
                <header className={styles.blockHead}>
                    <h3 className={styles.blockTitle}>Avis</h3>
                    <div className={styles.filters}>
                        <SearchSelect
                            className={styles.ratingFilter}
                            value={rating}
                            options={RATING_OPTIONS}
                            searchable={false}
                            onChange={setRating}
                            aria-label='Note'
                        />
                        <Checkbox checked={unanswered} onChange={setUnanswered}>
                            Sans réponse
                        </Checkbox>
                    </div>
                </header>

                <ErrorNote note={error} />
                <CapabilityNote app={app} sources={sources} capabilities={['reviews']} />
                {stores.includes('google') && (
                    <p className={styles.blockHint}>
                        Google ne donne que les avis des 7 derniers jours : ceux de Google Play remontent au jour où
                        l’app a été reliée.
                    </p>
                )}

                {reviews === null ? (
                    !error && <p className={styles.blockEmpty}>Chargement…</p>
                ) : reviews.length === 0 ? (
                    <p className={styles.blockEmpty}>
                        {filtered ? 'Aucun avis ne correspond à ces filtres.' : 'Aucun avis pour l’instant.'}
                    </p>
                ) : (
                    <ul className={styles.reviewList} data-stale={stale ? '' : undefined}>
                        {reviews.map((review) => (
                            <ReviewCard
                                key={review.id}
                                review={review}
                                replyBlocked={
                                    !canReply
                                        ? null
                                        : app.planPaused
                                          ? 'Au-delà de l’offre, cette app est en pause : ses avis ne se répondent plus d’ici.'
                                          : ''
                                }
                                onReply={() => setReplying(review)}
                            />
                        ))}
                    </ul>
                )}

                {hasMore && reviews && reviews.length > 0 && (
                    <div className={styles.more}>
                        <Button variant='secondary' disabled={loadingMore} onClick={() => void loadMore()}>
                            {loadingMore ? 'Lecture…' : 'Voir plus'}
                        </Button>
                    </div>
                )}
            </section>

            <ReplyDialog
                review={replying}
                onClose={() => setReplying(null)}
                onReplied={(review) => {
                    setReplying(null);
                    setReviews((prev) => prev?.map((entry) => (entry.id === review.id ? review : entry)) ?? prev);
                    invalidate('appstores.reviews');
                }}
            />
        </>
    );
}

interface ReviewCardProps {
    review: AppStoresReview;
    /** `null` : pas de geste ; `''` : répondre ; une phrase : le geste est là mais retenu, et elle dit pourquoi. */
    replyBlocked: string | null;
    onReply: () => void;
}

function ReviewCard({ review, replyBlocked, onReply }: ReviewCardProps) {
    const meta = [
        review.territory ? countryName(review.territory) : null,
        formatDate(review.createdAt),
        review.appVersion ? `version ${review.appVersion}` : null
    ].filter((part): part is string => part !== null);

    return (
        <li className={styles.review}>
            <div className={styles.reviewHead}>
                <Stars rating={review.rating} />
                <span className={styles.reviewMeta}>
                    <span
                        className={`icon icon-${STORE_ICONS[review.store]} ${styles.metaIcon}`}
                        role='img'
                        aria-label={STORE_LABELS[review.store]}
                        title={STORE_LABELS[review.store]}
                    />
                    {meta.join(' · ')}
                </span>
            </div>
            {review.title && <p className={styles.reviewTitle}>{review.title}</p>}
            {review.body && <p className={styles.reviewBody}>{review.body}</p>}
            <p className={styles.reviewAuthor}>{review.author}</p>

            {review.reply && (
                <div className={styles.reply}>
                    <p className={styles.replyHead}>
                        <span>Votre réponse</span>
                        <StatusBadge tone={review.reply.state === 'published' ? 'success' : 'warning'}>
                            {review.reply.state === 'published' ? 'Publiée' : 'En attente de publication'}
                        </StatusBadge>
                        {review.reply.at !== null && (
                            <span className={styles.replyDate}>{formatDate(review.reply.at)}</span>
                        )}
                    </p>
                    <p className={styles.replyBody}>{review.reply.body}</p>
                </div>
            )}

            {replyBlocked !== null && (
                <div className={styles.reviewActions}>
                    <Button
                        variant='ghost'
                        icon={review.reply ? 'edit' : 'chat-outline'}
                        disabled={replyBlocked !== ''}
                        title={replyBlocked || undefined}
                        onClick={onReply}
                    >
                        {review.reply ? 'Modifier la réponse' : 'Répondre'}
                    </Button>
                </div>
            )}
        </li>
    );
}

export default Reviews;
