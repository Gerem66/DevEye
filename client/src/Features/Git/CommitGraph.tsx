import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { GitCommitAuthor, GitCommitPoints, MinimalUser, UserColor } from 'deveye-types';
import { GIT_GRAPH_SHA_LEN } from 'deveye-types';
import { userColorVar } from '@/Features/Profile/userColors';
import { DAY_MS, startOfDay, timelineTicks } from '../Projects/Timeline/scale';
import { useElementWidth } from './useElementWidth';
import styles from './style.module.css';

const HEIGHT = 230;
/** Marges : la gauche loge les heures, le bas les dates. */
const PAD = { left: 44, right: 14, top: 12, bottom: 26 };
const DOT_R = 3.2;
/** Rayon de capture du survol et du clic, en px. */
const PICK_R = 14;
/** Graduations horaires : le quart de journée se lit sans compter. */
const HOUR_TICKS = [0, 6, 12, 18, 24];

/**
 * Largeur d'un seau de l'index spatial, en px.
 *
 * Égale au rayon de capture : une recherche n'examine alors que trois seaux
 * (celui du curseur et ses deux voisins), ce qui suffit à couvrir le disque de
 * capture quelle que soit la densité.
 */
const BUCKET_W = PICK_R;

/**
 * Une entrée de la légende : soit un auteur git, soit un **membre** qui en
 * réunit plusieurs.
 *
 * `refs` porte les auteurs git rassemblés — au moins un. C'est ce qui permet à
 * une personne qui commite sous trois adresses de n'occuper qu'un jeton dans la
 * légende, et à ses points de s'allumer ensemble quand on la survole.
 */
interface DisplayAuthor {
    /** Identité de l'entrée : `u:<id>` pour un membre, l'empreinte sinon. */
    key: string;
    name: string;
    /** Masqué pour un membre : c'est son compte qu'on nomme, pas une adresse. */
    detail: string;
    color: UserColor;
    commitCount: number;
    refs: string[];
}

interface CommitGraphProps {
    points: GitCommitPoints;
    authors: GitCommitAuthor[];
    firstCommitAt: number | null;
    lastCommitAt: number | null;
    total: number;
    /** Les membres de l'espace, pour nommer les auteurs rattachés. */
    members: MinimalUser[];
    /**
     * Réunir les auteurs rattachés sous leur membre (voir {@link DisplayAuthor}).
     *
     * Réglable depuis le dialogue de rattachement, activé par défaut : une fois
     * la configuration faite, on ne veut plus voir que de vraies personnes.
     */
    groupByMember: boolean;
    /** Ouvre le détail d'un commit ; absent = graphe non cliquable. */
    onOpenCommit?: (sha: string) => void;
    /**
     * Ouvre le rattachement des auteurs aux membres ; absent = pastille masquée.
     *
     * Elle est ici, en queue de légende, et non dans un repli posé sous le
     * graphe : la légende est l'endroit où l'on *lit* les auteurs, donc celui où
     * l'on remarque qu'il en manque un — et un dernier jeton après les leurs se
     * trouve sans être cherché.
     */
    onConfigure?: () => void;
}

/**
 * Tous les commits dans le temps : un point par commit, coloré par auteur.
 *
 * **Les deux axes portent une grandeur réelle.** L'abscisse est la date,
 * l'ordonnée **l'heure de la journée** — on lit d'un coup d'œil les nuits
 * blanches, les journées ouvrées, les week-ends. La dispersion est celle d'un
 * brouillage, mais elle veut dire quelque chose.
 *
 * ## Pourquoi un canvas
 *
 * Les points étaient un `<circle>` SVG chacun. À quelques milliers de commits le
 * navigateur portait autant de nœuds à mettre en page, à peindre et à conserver
 * en mémoire — et tout le reste de l'interface en pâtissait, jusqu'au défilement
 * de la page. Le canvas ramène le graphe à **un seul élément** et à un dessin
 * qu'on ne refait que lorsque les données, la largeur ou l'auteur mis en avant
 * changent.
 *
 * Les axes, eux, restent en SVG : ils sont une vingtaine d'éléments, ils portent
 * du texte, et le texte d'un canvas ne se sélectionne pas, ne se met pas à
 * l'échelle et ne suit pas le thème.
 *
 * ## Pourquoi un index spatial
 *
 * Le survol cherche le point le plus proche du curseur. Un balayage complet à
 * chaque `mousemove` — soixante fois par seconde, sur vingt mille points —
 * coûtait plus cher que le dessin lui-même. Les points sont donc rangés en
 * seaux par colonne de `BUCKET_W` pixels : une recherche n'en examine que trois.
 *
 * ## Pourquoi la légende n'est pas la liste des auteurs
 *
 * Une même personne commite sous plusieurs adresses selon la machine. Quand
 * `groupByMember` est actif — le réglage par défaut, décochable depuis le
 * dialogue de rattachement — les auteurs rattachés à un membre sont réunis sous
 * lui : voir {@link DisplayAuthor} et la table `display.slotOf`, qui traduit
 * l'indice d'auteur du serveur en entrée de légende. Le regroupement est donc
 * purement local ; le serveur rend toujours les auteurs bruts.
 */
export function CommitGraph({
    points,
    authors,
    firstCommitAt,
    lastCommitAt,
    total,
    members,
    groupByMember,
    onOpenCommit,
    onConfigure
}: CommitGraphProps) {
    /** L'entrée de légende mise en avant, désignée par sa `key`. */
    const [highlight, setHighlight] = useState<string | null>(null);
    const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
    const [boxRef, width] = useElementWidth<HTMLDivElement>();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    /** Bornes de la fenêtre, arrondies au jour : les graduations tombent juste. */
    const range = useMemo(() => {
        if (firstCommitAt === null || lastCommitAt === null) return null;
        const min = startOfDay(firstCommitAt * 1000);
        // Au moins une journée de fenêtre, sinon un dépôt d'un seul jour
        // diviserait par zéro.
        const max = Math.max(startOfDay(lastCommitAt * 1000) + DAY_MS, min + DAY_MS);
        return { min, max };
    }, [firstCommitAt, lastCommitAt]);

    /**
     * Les coordonnées en pixels, dans deux tableaux plats.
     *
     * `Float32Array` et non un tableau d'objets : à vingt mille points, c'est la
     * différence entre deux blocs de mémoire contigus et vingt mille objets à
     * allouer puis à ramasser. Le dessin et la recherche les parcourent tels
     * quels.
     */
    const placed = useMemo(() => {
        const n = points.count;
        const xs = new Float32Array(n);
        const ys = new Float32Array(n);
        if (!range || width <= 0 || n === 0) return { xs, ys };

        const plotW = Math.max(1, width - PAD.left - PAD.right);
        const plotH = HEIGHT - PAD.top - PAD.bottom;
        const span = range.max - range.min;
        for (let i = 0; i < n; i++) {
            const at = points.committedAt[i] * 1000;
            const date = new Date(at);
            const hour = date.getHours() + date.getMinutes() / 60;
            xs[i] = PAD.left + ((at - range.min) / span) * plotW;
            ys[i] = PAD.top + (hour / 24) * plotH;
        }
        return { xs, ys };
    }, [points, range, width]);

    /** Les indices rangés par colonne de `BUCKET_W` pixels (voir l'en-tête). */
    const buckets = useMemo(() => {
        const map = new Map<number, number[]>();
        for (let i = 0; i < points.count; i++) {
            const key = Math.floor(placed.xs[i] / BUCKET_W);
            const slot = map.get(key);
            if (slot) slot.push(i);
            else map.set(key, [i]);
        }
        return map;
    }, [placed, points.count]);

    /**
     * La légende telle qu'elle s'affiche, et la table qui y mène.
     *
     * `slotOf[i]` donne, pour l'indice d'auteur `i` du serveur, l'entrée de
     * légende correspondante. Un `Int32Array` plutôt qu'une `Map` : le dessin et
     * la recherche le consultent une fois par point, à chaque image.
     *
     * Le regroupement se fait **ici et non côté serveur** : c'est une préférence
     * d'affichage propre au navigateur, et la réponse du graphe reste la même
     * pour tout le monde — la basculer ne coûte donc pas un aller-retour.
     */
    const display = useMemo(() => {
        const usernames = new Map(members.map((m) => [m.id, m.username]));
        const slotOf = new Int32Array(authors.length);
        const groups: DisplayAuthor[] = [];
        const index = new Map<string, number>();

        authors.forEach((author, i) => {
            // Sans regroupement, chaque auteur git garde son entrée — mais il
            // porte déjà la couleur de son compte quand il en a un.
            const memberId = groupByMember ? author.userId : null;
            const key = memberId === null ? author.authorRef : `u:${memberId}`;
            let slot = index.get(key);
            if (slot === undefined) {
                slot = groups.length;
                index.set(key, slot);
                groups.push({
                    key,
                    name:
                        memberId === null
                            ? author.name || author.email || 'Auteur inconnu'
                            : usernames.get(memberId) || author.name || author.email || 'Membre',
                    detail: memberId === null ? author.email : '',
                    color: author.color,
                    commitCount: 0,
                    refs: []
                });
            }
            groups[slot].commitCount += author.commitCount;
            groups[slot].refs.push(author.authorRef);
            slotOf[i] = slot;
        });

        return { authors: groups, slotOf };
    }, [authors, members, groupByMember]);

    /** La couleur de chaque entrée de légende, résolue une fois pour le dessin. */
    const authorColors = useMemo(() => display.authors.map((a) => userColorVar(a.color)), [display]);

    /**
     * Le dessin, refait seulement quand quelque chose de visible a changé.
     *
     * Les variables CSS (`--color-…`) ne veulent rien dire pour un canvas : on
     * les résout une fois contre l'élément, sinon chaque point serait peint en
     * noir.
     */
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || width <= 0) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Écran haute densité : le canvas travaille en pixels physiques et se
        // laisse mettre à l'échelle en CSS, sinon les disques sont flous.
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(HEIGHT * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, HEIGHT);

        const styleOf = getComputedStyle(canvas);
        const resolved = authorColors.map((c) => {
            const name = c.match(/^var\((--[\w-]+)\)$/)?.[1];
            return name ? styleOf.getPropertyValue(name).trim() || '#6b7280' : c;
        });

        // Groupés par entrée de légende : changer `fillStyle` est l'opération
        // chère d'un canvas, on la fait une fois par couleur au lieu d'une fois
        // par point. Un membre qui réunit trois auteurs git n'en coûte donc
        // qu'une seule, et ses points se dessinent d'un trait.
        for (let slot = 0; slot < resolved.length; slot++) {
            const dim = highlight !== null && display.authors[slot]?.key !== highlight;
            ctx.fillStyle = resolved[slot];
            ctx.globalAlpha = dim ? 0.1 : 0.85;
            ctx.beginPath();
            for (let i = 0; i < points.count; i++) {
                if (display.slotOf[points.authorIndex[i]] !== slot) continue;
                ctx.moveTo(placed.xs[i] + DOT_R, placed.ys[i]);
                ctx.arc(placed.xs[i], placed.ys[i], DOT_R, 0, Math.PI * 2);
            }
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }, [placed, points, display, authorColors, highlight, width]);

    const ticks = useMemo(() => {
        if (!range || width <= 0) return [];
        const plotW = Math.max(1, width - PAD.left - PAD.right);
        const days = (range.max - range.min) / DAY_MS;
        return timelineTicks(range.min, range.max, plotW / days);
    }, [range, width]);

    if (points.count === 0 || !range) {
        return <p className={styles.empty}>Aucun commit synchronisé pour l’instant.</p>;
    }

    const plotW = Math.max(1, width - PAD.left - PAD.right);
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + ((t - range.min) / (range.max - range.min)) * plotW;
    const yHour = (hour: number) => PAD.top + (hour / 24) * plotH;

    /** Le sha d'un point, découpé à la demande dans la chaîne concaténée. */
    const shaAt = (i: number) => points.shas.slice(i * GIT_GRAPH_SHA_LEN, (i + 1) * GIT_GRAPH_SHA_LEN);

    /**
     * Le point le plus proche du curseur.
     *
     * Trois seaux seulement, jamais tout le nuage : voir l'en-tête du fichier.
     */
    const pick = (e: MouseEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const key = Math.floor(px / BUCKET_W);

        let best = -1;
        let bestDist = PICK_R * PICK_R;
        for (let k = key - 1; k <= key + 1; k++) {
            const slot = buckets.get(k);
            if (!slot) continue;
            for (const i of slot) {
                // Une entrée mise en avant capture seule : cliquer « à travers »
                // les points estompés donnerait un commit qu'on ne voit pas.
                if (highlight !== null && display.authors[display.slotOf[points.authorIndex[i]]]?.key !== highlight) {
                    continue;
                }
                const dx = placed.xs[i] - px;
                const dy = placed.ys[i] - py;
                const dist = dx * dx + dy * dy;
                if (dist <= bestDist) {
                    bestDist = dist;
                    best = i;
                }
            }
        }
        return best;
    };

    const fmtDay = (t: number) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    const fmtRange = (t: number) => new Date(t * 1000).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });

    const hovered = hover ? display.authors[display.slotOf[points.authorIndex[hover.index]]] : undefined;

    return (
        <div className={styles.graphWrap}>
            <div className={styles.graphHead}>
                <span>
                    {total} commit{total > 1 ? 's' : ''}
                    {/* Le serveur borne les points transportés : quand il en manque,
                        on le dit plutôt que de laisser croire à un dépôt plus petit. */}
                    {points.count < total && ` · ${points.count} affichés`}
                </span>
                <span className={styles.graphRange}>
                    {firstCommitAt !== null && lastCommitAt !== null && (
                        <>
                            {fmtRange(firstCommitAt)} → {fmtRange(lastCommitAt)}
                        </>
                    )}
                </span>
            </div>

            {/* Les gestes vivent sur la boîte, pas sur le canvas : le repère de
                `getBoundingClientRect` est alors le même que celui des axes SVG
                superposés, quel que soit le rapport de pixels de l'écran. */}
            <div
                className={styles.graphBox}
                ref={boxRef}
                onMouseMove={(e) => {
                    const best = pick(e);
                    setHover(best < 0 ? null : { index: best, x: placed.xs[best], y: placed.ys[best] });
                }}
                onMouseLeave={() => setHover(null)}
                onClick={(e) => {
                    const best = pick(e);
                    if (best >= 0 && onOpenCommit) onOpenCommit(shaAt(best));
                }}
                style={{ cursor: hover && onOpenCommit ? 'pointer' : 'default' }}
            >
                <canvas
                    ref={canvasRef}
                    className={styles.graphCanvas}
                    style={{ width, height: HEIGHT }}
                    role='img'
                    aria-label={`Graphe de ${total} commits, par date et heure de la journée`}
                />

                {/* Axes et graduations : une vingtaine d'éléments, du texte, et
                    rien qui grandisse avec le nombre de commits. */}
                {width > 0 && (
                    <svg className={styles.graphAxes} width={width} height={HEIGHT} aria-hidden='true'>
                        {HOUR_TICKS.map((hour) => (
                            <g key={hour}>
                                <line
                                    x1={PAD.left}
                                    x2={width - PAD.right}
                                    y1={yHour(hour)}
                                    y2={yHour(hour)}
                                    className={hour === 0 || hour === 24 ? styles.graphAxis : styles.graphGrid}
                                />
                                <text
                                    x={PAD.left - 8}
                                    y={yHour(hour)}
                                    className={styles.graphLabel}
                                    textAnchor='end'
                                    dominantBaseline='middle'
                                >
                                    {String(hour).padStart(2, '0')}h
                                </text>
                            </g>
                        ))}

                        {ticks.map((tick) => (
                            <g key={tick.t}>
                                <line
                                    x1={x(tick.t)}
                                    x2={x(tick.t)}
                                    y1={PAD.top}
                                    y2={HEIGHT - PAD.bottom}
                                    className={tick.major ? styles.graphGridMajor : styles.graphGrid}
                                />
                                <text
                                    x={x(tick.t)}
                                    y={HEIGHT - PAD.bottom + 15}
                                    className={styles.graphLabel}
                                    textAnchor='middle'
                                >
                                    {tick.label}
                                </text>
                            </g>
                        ))}

                        {hover && <circle cx={hover.x} cy={hover.y} r={DOT_R + 3} className={styles.graphHalo} />}
                    </svg>
                )}

                {hover && (
                    <div
                        className={styles.graphTip}
                        style={{
                            // Bascule à gauche près du bord droit, sinon l'info-bulle
                            // sortirait de la boîte.
                            left: hover.x > width - 190 ? undefined : hover.x + 12,
                            right: hover.x > width - 190 ? width - hover.x + 12 : undefined,
                            top: Math.max(0, hover.y - 8)
                        }}
                    >
                        <code>{shaAt(hover.index).slice(0, 7)}</code>
                        <span>{hovered?.name || 'Auteur inconnu'}</span>
                        <span className={styles.hint}>
                            {fmtDay(points.committedAt[hover.index] * 1000)}
                            {' · '}
                            {new Date(points.committedAt[hover.index] * 1000).toLocaleTimeString('fr-FR', {
                                hour: '2-digit',
                                minute: '2-digit'
                            })}
                        </span>
                    </div>
                )}
            </div>

            <ul className={styles.legend}>
                {display.authors
                    .slice()
                    .sort((a, b) => b.commitCount - a.commitCount)
                    .map((author) => (
                        <li key={author.key}>
                            <button
                                type='button'
                                className={highlight === author.key ? styles.legendOn : styles.legendItem}
                                // Un membre réunissant plusieurs auteurs git le
                                // dit au survol : la légende reste lisible, et
                                // l'information n'est pas perdue pour autant.
                                title={author.refs.length > 1 ? `${author.refs.length} auteurs git réunis` : undefined}
                                onMouseEnter={() => setHighlight(author.key)}
                                onMouseLeave={() => setHighlight(null)}
                                onClick={() => setHighlight(highlight === author.key ? null : author.key)}
                            >
                                <span className={styles.legendDot} style={{ background: userColorVar(author.color) }} />
                                {author.name}
                                <span className={styles.legendCount}>{author.commitCount}</span>
                            </button>
                        </li>
                    ))}

                {/* Dernier jeton de la légende, à la suite des auteurs : c'est
                    en les lisant qu'on voit qu'il en manque un à rattacher. */}
                {onConfigure && (
                    <li>
                        <button type='button' className={styles.legendConfig} onClick={onConfigure}>
                            <span className='icon icon-settings' />
                            Paramétrer
                        </button>
                    </li>
                )}
            </ul>
        </div>
    );
}

export default CommitGraph;
