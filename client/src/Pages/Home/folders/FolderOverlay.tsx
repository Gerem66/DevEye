import { useEffect, useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import {
    AnimatePresence,
    animate,
    motion,
    useMotionValue,
    usePresence,
    useReducedMotion,
    useTransform
} from 'framer-motion';
import type { HomeFeatureId, HomeFolder } from '@deveye/types';

import { Widget } from '@/Components/Widget';
import { WidgetGrid } from '@/Components/WidgetGrid';
import { useDismissLayer } from '@/Components/Dialog';
import type { FeatureCatalogEntry } from '../catalog';
import { FolderTile } from './FolderTile';
import { folderKey, folderTitle } from './identity';
import styles from './folders.module.css';

/**
 * Les cartes partent ensemble mais décalées (un éventail, pas un bloc). Le repli
 * est plus serré et en ordre inverse : la dernière sortie rentre la première,
 * la pile se reconstitue.
 */
const STAGGER_IN = 0.045;
const STAGGER_OUT = 0.03;
const SPRING = { type: 'spring', stiffness: 240, damping: 28, mass: 0.9 } as const;
const FOLD_BACK = { duration: 0.32, ease: [0.4, 0, 0.2, 1] } as const;

/**
 * Avancement de l'éventail (0 = pile, 1 = posé) entre lequel le couvercle
 * s'efface. Accroché à l'avancement réel du ressort et non à une durée
 * calculée : le couvercle disparaît pendant que l'éventail s'étale, de la même
 * façon quel que soit le nombre de cartes.
 */
const LID_FADE_FROM = 0.22;
const LID_FADE_TO = 0.6;

/** Le retour du couvercle, plus court que `FOLD_BACK` : il doit être opaque
 *  avant que la première carte ne revienne se ranger dessous. */
const LID_RESTACK = { duration: 0.16, ease: 'easeOut' } as const;

/** Où poser une carte pour qu'elle se confonde avec la tuile du dossier. */
function stackedOn(source: DOMRect, slot: { left: number; top: number; width: number }) {
    return {
        x: source.left - slot.left,
        y: source.top - slot.top,
        scale: slot.width > 0 ? source.width / slot.width : 1
    };
}

interface FanCardProps {
    /** Rang dans le déploiement : c'est lui qui décale le départ de la carte. */
    index: number;
    /** Combien de cartes en tout, pour replier dans l'ordre inverse. */
    count: number;
    /** La tuile d'où elles sortent, mesurée au moment du clic. */
    source: DOMRect;
    /** Sa vue est ouverte par-dessus : la carte s'efface pour ne pas doubler la popup. */
    hidden: boolean;
    children: ReactNode;
}

/**
 * Une carte du déploiement, posée par la grille à sa place d'arrivée ; le
 * transform la ramène sur la tuile, la mise en page reste celle de l'accueil.
 * Les valeurs sont des `MotionValue` écrites en `useLayoutEffect`, pas des
 * props `initial`/`animate` : elles atteignent le DOM avant la peinture, la
 * carte est déjà empilée sur la tuile au premier affichage.
 */
function FanCard({ index, count, source, hidden, children }: FanCardProps) {
    const reduced = useReducedMotion() === true;
    const ref = useRef<HTMLDivElement>(null);
    const [isPresent, safeToRemove] = usePresence();
    const x = useMotionValue(0);
    const y = useMotionValue(0);
    const scale = useMotionValue(1);

    // Le déploiement. Monté une fois : la carte ne rejoue pas son entrée parce
    // qu'un widget voisin s'est rafraîchi.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || reduced) return;
        const rect = el.getBoundingClientRect();
        const from = stackedOn(source, rect);
        x.set(from.x);
        y.set(from.y);
        scale.set(from.scale);
        const delay = index * STAGGER_IN;
        const running = [
            animate(x, 0, { ...SPRING, delay }),
            animate(y, 0, { ...SPRING, delay }),
            animate(scale, 1, { ...SPRING, delay })
        ];
        return () => running.forEach((a) => a.stop());
        // Monté une fois : les dépendances de l'entrée sont figées au premier rendu.
    }, []);

    // Le repli, déclenché par AnimatePresence : la couche reste montée tant que
    // la dernière carte n'a pas signalé son retour.
    useEffect(() => {
        if (isPresent) return;
        const el = ref.current;
        if (!el || reduced) {
            safeToRemove();
            return;
        }
        // La place d'arrivée, retrouvée en retirant la transformation en cours :
        // fermer pendant le déploiement ne renvoie donc pas les cartes à côté.
        const rect = el.getBoundingClientRect();
        const current = scale.get() || 1;
        const slot = { left: rect.left - x.get(), top: rect.top - y.get(), width: rect.width / current };
        const back = stackedOn(source, slot);
        const delay = (count - 1 - index) * STAGGER_OUT;
        const running = [
            animate(x, back.x, { ...FOLD_BACK, delay }),
            animate(y, back.y, { ...FOLD_BACK, delay }),
            animate(scale, back.scale, { ...FOLD_BACK, delay })
        ];
        void Promise.all(running.map((a) => a.finished))
            .then(() => {
                // Posée, la carte se cache elle-même : la couche ne se démonte
                // qu'une fois la dernière carte rentrée, et pendant ce battement
                // une carte posée pouvait ressortir quelques images, figée.
                el.style.visibility = 'hidden';
                safeToRemove();
            })
            .catch(() => {});
        return () => running.forEach((a) => a.stop());
    }, [isPresent]);

    return (
        <motion.div
            ref={ref}
            className={`${styles.card} ${hidden ? styles.cardHidden : ''}`}
            style={{ x, y, scale }}
            // Le clic sur une carte lui appartient : c'est la couche entière qui
            // referme le dossier, sauf ici.
            onClick={(e) => e.stopPropagation()}
        >
            {children}
        </motion.div>
    );
}

/**
 * Le couvercle : une copie de la tuile du dossier sur la couche, par-dessus les
 * cartes, qui glissent sous elle au départ comme au retour (la vraie tuile est
 * sous la couche). `spread` rejoue le mouvement de la dernière carte de 0 à 1 :
 * le couvercle lit un avancement réel, pas une durée supposée. Décoratif :
 * `.lid` laisse passer les clics.
 */
function FolderLid({ count, source, children }: { count: number; source: DOMRect; children: ReactNode }) {
    const [isPresent, safeToRemove] = usePresence();
    const spread = useMotionValue(0);
    const opacity = useTransform(spread, [LID_FADE_FROM, LID_FADE_TO], [1, 0]);

    useLayoutEffect(() => {
        const running = animate(spread, 1, { ...SPRING, delay: Math.max(count - 1, 0) * STAGGER_IN });
        return () => running.stop();
        // Monté une fois, comme les cartes : l'éventail déjà parti ne change plus.
    }, []);

    // Le repli : le couvercle redevient opaque, puis la couche attend que les
    // cartes soient rentrées pour disparaître.
    useEffect(() => {
        if (isPresent) return;
        const running = animate(spread, 0, LID_RESTACK);
        void running.finished.then(() => safeToRemove()).catch(() => {});
        return () => running.stop();
    }, [isPresent]);

    return (
        <motion.div
            className={styles.lid}
            style={{ left: source.left, top: source.top, width: source.width, height: source.height, opacity }}
        >
            {children}
        </motion.div>
    );
}

export interface FolderOverlayProps {
    /** Le dossier déployé, ou `null` quand rien ne l'est. */
    folder: HomeFolder | null;
    /** Son contenu visible, dans l'ordre du dossier (voir `folderFeatures`). */
    entries: FeatureCatalogEntry[];
    /** La tuile d'origine, mesurée au clic : le point de départ et de retour. */
    source: DOMRect | null;
    /**
     * Hauteur de l'en-tête de l'accueil, en pixels, pour que les cartes se posent
     * sur les places des tuiles. Mesurée : elle change avec la largeur de la
     * fenêtre.
     */
    topOffset: number;
    /** La vue actuellement ouverte par-dessus, s'il y en a une. */
    expandedWidget: string | null;
    /** Ce rôle n'ouvre pas cette fonctionnalité : carte en retrait, comme sur la grille. */
    isLocked: (id: HomeFeatureId) => boolean;
    onOpenFeature: (id: HomeFeatureId, e: MouseEvent<HTMLDivElement>) => void;
    onClose: () => void;
}

/**
 * Le dossier déployé par-dessus l'accueil. Ce n'est pas une vue : rien dans la
 * popup, rien dans la présence en direct ; une carte déployée s'ouvre et se
 * rejoint comme sa jumelle sur la grille. La couche se cale sur la géométrie de
 * l'accueil ; le flou et le retrait sont portés par l'accueil, pas par la
 * couche, sinon les cartes se flouteraient avec lui.
 */
export function FolderOverlay({
    folder,
    entries,
    source,
    topOffset,
    expandedWidget,
    isLocked,
    onOpenFeature,
    onClose
}: FolderOverlayProps) {
    const reduced = useReducedMotion() === true;
    const open = folder !== null && source !== null;
    // Échap referme le dossier, sauf si une vue s'est ouverte par-dessus : elle
    // s'est inscrite après nous, donc elle passe la première.
    useDismissLayer(open, onClose);

    return (
        <AnimatePresence>
            {open && (
                // Tout ce qui n'est pas une carte referme, gouttières comprises.
                <div key='folder' className={styles.layer} onClick={onClose}>
                    <motion.div
                        className={styles.scrim}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.28, ease: 'easeOut' }}
                    />
                    <div className={styles.content} style={{ paddingTop: `calc(var(--space-lg) + ${topOffset}px)` }}>
                        <WidgetGrid>
                            {entries.map((entry, index) => {
                                const locked = isLocked(entry.id);
                                return (
                                    <FanCard
                                        key={entry.id}
                                        index={index}
                                        count={entries.length}
                                        source={source}
                                        hidden={expandedWidget === entry.id}
                                    >
                                        <Widget
                                            widgetId={entry.id}
                                            title={entry.title}
                                            icon={entry.icon}
                                            className={locked ? styles.lockedCard : undefined}
                                            onExpand={(e) => onOpenFeature(entry.id, e)}
                                        >
                                            {/* Même choix que la grille : le contenu vivant est
                                                remplacé, pas grisé, sinon il interrogerait un
                                                serveur qui refuse. */}
                                            {locked ? (
                                                <span className={styles.lockedBody}>Accès restreint</span>
                                            ) : (
                                                <entry.WidgetContent />
                                            )}
                                        </Widget>
                                    </FanCard>
                                );
                            })}
                        </WidgetGrid>
                    </div>

                    {/* Le couvercle en dernier : à z-index égal, l'ordre de l'arbre
                        décide. Sans mouvement, il n'a rien à cacher. */}
                    {!reduced && (
                        <FolderLid count={entries.length} source={source}>
                            <Widget
                                widgetId={folderKey(folder.id)}
                                title={folderTitle(folder.title)}
                                icon='folder'
                                interactive={false}
                            >
                                <FolderTile folder={folder} />
                            </Widget>
                        </FolderLid>
                    )}
                </div>
            )}
        </AnimatePresence>
    );
}

export default FolderOverlay;
