import { motion } from 'framer-motion';
import { useEffect, useReducer, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import { useAuth } from '@/auth/AuthProvider';
import { userColorVar } from '@/Features/Profile/userColors';
import { useLive } from '@/stores/live';
import { useActiveWorkspace } from '@/stores/workspace';
import { CURSOR_GLYPHS } from './cursorGlyphs';
import { useSays } from './cursorChat';
import { useHideLiveCursors } from './hideCursors';
import { useLiveSurface } from './LiveProvider';
import styles from './LiveCursors.module.css';

/**
 * Les curseurs des pairs qui sont exactement là où nous sommes. Le serveur a déjà
 * fait le tri ; il ne reste qu'à replacer les coordonnées dans notre surface et à
 * en tirer un pseudo, une couleur et une forme.
 *
 * La surface sert de repère, pas de cadre : un curseur reste affiché dans les
 * marges de la popup et jusqu'aux bords de l'écran. Seule la fenêtre borne
 * l'affichage, et au-delà le curseur est masqué plutôt qu'épinglé au bord, où il
 * se lirait comme quelqu'un qui serait là sans y être.
 */

/**
 * La géométrie de la surface, lue au rendu et jamais mémorisée. La mettre en
 * cache sur `ResizeObserver` serait faux : la popup s'ouvre par un morphe
 * framer-motion qui anime un `transform`, lequel ne change pas la boîte de
 * bordure et ne déclenche donc aucun observateur ; la mesure resterait figée sur
 * la taille de la carte d'origine et les curseurs atterriraient hors cadre.
 *
 * Lire au rendu est bon marché : ce composant ne rend que lorsqu'un curseur
 * bouge, au plus une fois par tic de 50 ms. Les abonnements ci-dessous ne servent
 * qu'à provoquer un rendu quand le cadre change sans que les pairs bougent.
 */
function useSurfaceGeometry(surface: HTMLElement | null): { rect: DOMRect; scrollTop: number } | null {
    const [, bump] = useReducer((n: number) => n + 1, 0);

    useEffect(() => {
        if (!surface) return;
        const observer = new ResizeObserver(bump);
        observer.observe(surface);
        // En capture, sur le document : le repère de l'accueil ne défile pas
        // lui-même, c'est son parent qui bouge, et un écouteur posé dessus raterait
        // tout défilement de la page.
        document.addEventListener('scroll', bump, { passive: true, capture: true });
        window.addEventListener('resize', bump);
        return () => {
            observer.disconnect();
            document.removeEventListener('scroll', bump, { capture: true });
            window.removeEventListener('resize', bump);
        };
    }, [surface]);

    if (!surface) return null;
    return { rect: surface.getBoundingClientRect(), scrollTop: surface.scrollTop };
}

export function LiveCursors() {
    const { cursors, peers } = useLive();
    const says = useSays();
    const { user } = useAuth();
    const workspace = useActiveWorkspace();
    const surface = useLiveSurface();
    const geometry = useSurfaceGeometry(surface);
    const hidden = useHideLiveCursors();

    // Un espace personnel est une salle d'une personne : rien à afficher. La sortie
    // est ici, après les hooks, que React n'admet pas conditionnels.
    if (!geometry || !workspace || workspace.kind === 'personal' || hidden || cursors.length === 0) return null;

    const members = new Map((workspace.users ?? []).map((u) => [u.id, u]));
    // La couleur n'est pas répétée dans la trame de curseur : elle est déjà dans
    // le roster, qui arrive avant et se met à jour tout seul quand elle change.
    const colors = new Map(peers.map((p) => [p.connId, p.color]));
    // La bulle est jointe au curseur par la connexion : elle n'existe donc que là
    // où un curseur est dessiné, et disparaît avec lui.
    const texts = new Map(says.map((s) => [s.connId, s.text]));
    const { rect, scrollTop } = geometry;

    // Le cadre est la fenêtre, jamais la surface.
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;

    const visible = cursors.flatMap((entry) => {
        // Mes propres autres onglets : c'est moi, ça n'apprend rien.
        if (user && entry.userId === user.id) return [];
        const color = colors.get(entry.connId);
        if (!color) return [];
        const member = members.get(entry.userId);
        const left = rect.left + entry.cursor.x * rect.width;
        const top = rect.top + entry.cursor.y - scrollTop;
        if (top < 0 || top > viewHeight || left < 0 || left > viewWidth) return [];
        const glyph = CURSOR_GLYPHS[entry.cursor.kind];
        return [
            {
                ...entry,
                color,
                left,
                top,
                glyph,
                username: member?.username ?? 'Membre',
                text: texts.get(entry.connId) ?? null
            }
        ];
    });

    if (visible.length === 0) return null;

    return createPortal(
        <div className={styles.layer} aria-hidden='true'>
            {visible.map((c) => (
                <motion.div
                    key={c.connId}
                    className={styles.cursor}
                    // Interpolé : les trames arrivent par paquets de 50 ms, et un saut
                    // par trame se lirait comme une saccade. Ressort ferme, pour ne
                    // pas traîner derrière.
                    initial={false}
                    // Le point chaud du dessin (pointe de flèche, bout du doigt)
                    // doit tomber sur la position reçue.
                    animate={{ x: c.left - c.glyph.offsetX, y: c.top - c.glyph.offsetY }}
                    transition={{ type: 'spring', stiffness: 700, damping: 45, mass: 0.6 }}
                    style={{ '--peer': userColorVar(c.color) } as CSSProperties}
                >
                    <svg
                        className={styles.glyph}
                        width={c.glyph.width}
                        height={c.glyph.height}
                        viewBox={c.glyph.viewBox}
                        fill='currentColor'
                    >
                        {c.glyph.shape}
                    </svg>
                    <div className={styles.stack} style={{ marginTop: c.glyph.labelOffset }}>
                        <span className={styles.label}>{c.username}</span>
                        {c.text !== null && <span className={styles.bubble}>{c.text}</span>}
                    </div>
                </motion.div>
            ))}
        </div>,
        document.body
    );
}
