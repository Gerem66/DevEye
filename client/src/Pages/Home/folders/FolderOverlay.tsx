import { useEffect, useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { AnimatePresence, animate, motion, useMotionValue, usePresence, useReducedMotion } from 'framer-motion';
import type { HomeFeatureId, HomeFolder } from 'deveye-types';

import { Widget } from '@/Components/Widget';
import { WidgetGrid } from '@/Components/WidgetGrid';
import { useDismissLayer } from '@/Components/Dialog';
import type { FeatureCatalogEntry } from '../catalog';
import { FolderTile } from './FolderTile';
import { folderKey, folderTitle } from './identity';
import styles from './folders.module.css';

/**
 * Le décalage de départ, puis d'arrivée, de chaque carte.
 *
 * « En parallèle avec un léger délai » : les cartes partent ensemble mais pas au
 * même instant, ce qui donne à lire un éventail plutôt qu'un bloc. Le repli est
 * plus serré et en ordre inverse, pour que la dernière sortie soit la première
 * rentrée : c'est ce qui fait que la pile se reconstitue au lieu de s'écrouler.
 */
const STAGGER_IN = 0.045;
const STAGGER_OUT = 0.03;
const SPRING = { type: 'spring', stiffness: 240, damping: 28, mass: 0.9 } as const;
const FOLD_BACK = { duration: 0.32, ease: [0.4, 0, 0.2, 1] } as const;

/**
 * Le couvercle : une copie de la tuile du dossier, posée sur la couche, au même
 * endroit et par-dessus les cartes.
 *
 * C'est ce qui donne le « dessous ». Les cartes vivent sur une couche fixe,
 * au-dessus de l'accueil : rien ne peut les faire passer derrière la vraie
 * tuile, qui est en dessous. Une copie sur la couche, elle, se met devant, et
 * les cartes glissent sous elle au départ comme au retour. Elle s'efface une
 * fois l'éventail sorti, sinon elle masquerait la carte qui vient prendre sa
 * place, et revient juste avant que les cartes ne rentrent.
 *
 * Le repli dure `FOLD_BACK` : le couvercle a largement le temps de redevenir
 * opaque avant que la première carte n'arrive.
 */
const LID_FADE_OUT = { duration: 0.3 } as const;
const LID_FADE_IN = { duration: 0.16 } as const;

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
 * Une carte du déploiement.
 *
 * Elle est posée par la grille, à sa place d'arrivée, et c'est le transform qui
 * la ramène sur la tuile : la mise en page reste celle de l'accueil (mêmes
 * colonnes, mêmes gouttières), et l'animation ne fait que la traverser. Calculer
 * les positions à la main aurait dupliqué la grille CSS, qui aurait fini par
 * diverger d'elle.
 *
 * Les valeurs sont des `MotionValue` écrites en `useLayoutEffect`, pas des props
 * `initial`/`animate` : elles atteignent le DOM **avant la peinture**, donc la
 * carte est déjà empilée sur la tuile au premier affichage. Avec `initial`, il
 * aurait fallu mesurer d'abord, donc rendre une fois, donc laisser voir les
 * cartes à leur place d'arrivée le temps d'une image.
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
            .then(() => safeToRemove())
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

export interface FolderOverlayProps {
    /** Le dossier déployé, ou `null` quand rien ne l'est. */
    folder: HomeFolder | null;
    /** Son contenu visible, dans l'ordre du dossier (voir `folderFeatures`). */
    entries: FeatureCatalogEntry[];
    /** La tuile d'origine, mesurée au clic : le point de départ et de retour. */
    source: DOMRect | null;
    /**
     * La hauteur de l'en-tête de l'accueil, en pixels.
     *
     * Les cartes se posent en dessous, donc exactement là où commence la grille
     * quand l'accueil est en haut de sa course : ce qui se déploie prend les
     * places des tuiles, pas des places décalées vers le haut. Mesurée plutôt
     * que devinée, l'en-tête changeant de hauteur avec la largeur de la fenêtre.
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
 * Le dossier déployé par-dessus l'accueil.
 *
 * Ce n'est **pas** une vue : rien n'est monté dans la popup, aucun identifiant
 * ne part dans la présence en direct, et la barre du haut garde la main (elle
 * porte l'intitulé et le retour, comme pour un écran de fonctionnalité). Un
 * dossier n'est qu'un rangement de l'accueil, et se comporter comme tel est ce
 * qui le rend compatible avec le reste sans ligne particulière ailleurs : une
 * carte déployée s'ouvre, se partage et se rejoint exactement comme sa jumelle
 * posée sur la grille.
 *
 * La couche se cale sur la géométrie de l'accueil (même colonne centrale, mêmes
 * marges, même grille), donc les cartes arrivent précisément sur les places des
 * tuiles ordinaires. Le fond, lui, recule : c'est l'accueil qui porte le flou et
 * le léger retrait (voir `Dashboard.module.css`), pas cette couche, sinon les
 * cartes se flouteraient avec lui.
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
                // Tout ce qui n'est pas une carte referme : les gouttières de la
                // grille et le bas de page en font partie, et viser le voile à
                // côté d'une carte est le geste naturel pour revenir.
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
                                            adminOnly={entry.adminOnly}
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

                    {/* Le couvercle, en dernier : à z-index égal c'est l'ordre de
                        l'arbre qui décide, donc il couvre les cartes sans avoir à
                        empiler qui que ce soit. Sans mouvement, il n'a rien à
                        cacher : les cartes ne traversent alors pas la tuile. */}
                    {!reduced && (
                        <motion.div
                            className={styles.lid}
                            style={{
                                left: source.left,
                                top: source.top,
                                width: source.width,
                                height: source.height
                            }}
                            initial={{ opacity: 1 }}
                            animate={{
                                opacity: 0,
                                // Le temps que la dernière carte se soit dégagée.
                                transition: { ...LID_FADE_OUT, delay: entries.length * STAGGER_IN + 0.12 }
                            }}
                            // Le retour est immédiat : il doit être opaque avant
                            // que la première carte ne revienne se ranger.
                            exit={{ opacity: 1, transition: LID_FADE_IN }}
                        >
                            <Widget
                                widgetId={folderKey(folder.id)}
                                title={folderTitle(folder.title)}
                                icon='folder'
                                interactive={false}
                            >
                                <FolderTile folder={folder} />
                            </Widget>
                        </motion.div>
                    )}
                </div>
            )}
        </AnimatePresence>
    );
}

export default FolderOverlay;
