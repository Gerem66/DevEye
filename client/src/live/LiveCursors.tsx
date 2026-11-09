import { motion, useMotionValue, useSpring, useTransform, type MotionStyle } from 'framer-motion';
import { useEffect, useReducer, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { LiveCursorKind, UserColor } from '@deveye/types';

import { useAuth } from '@/auth/AuthProvider';
import { userColorVar } from '@/Features/Profile/userColors';
import { useLive } from '@/stores/live';
import { useActiveWorkspace } from '@/stores/workspace';
import { CURSOR_GLYPHS } from './cursorGlyphs';
import { useSays } from './cursorChat';
import type { CursorSurface } from './cursorSurface';
import { useHideLiveCursors } from './hideCursors';
import { useLiveSurface } from './LiveProvider';
import styles from './LiveCursors.module.css';

/**
 * Les curseurs des pairs qui partagent notre surface. Le serveur a déjà fait le
 * tri ; il ne reste qu'à replacer les coordonnées à l'écran et à en tirer un
 * pseudo, une couleur et une forme.
 *
 * La surface sert de repère, pas de cadre : un curseur reste affiché dans les
 * marges de la popup et jusqu'aux bords de l'écran. Seule la fenêtre borne
 * l'affichage, et au-delà le curseur est masqué plutôt qu'épinglé au bord, où il
 * se lirait comme quelqu'un qui serait là sans y être.
 */

/** Ferme, pour ne pas traîner derrière les trames qui arrivent par paquets de 50 ms. */
const GLIDE = { stiffness: 700, damping: 45, mass: 0.6 };

/**
 * Réaffiche quand la surface bouge sans que les pairs bougent : un défilement,
 * un zoom. La géométrie, elle, se relit à chaque appel de `toScreen`.
 */
function useSurfaceChanges(surface: CursorSurface | null): void {
    const [, bump] = useReducer((n: number) => n + 1, 0);
    useEffect(() => surface?.subscribe(bump), [surface]);
}

/**
 * Un curseur, interpolé dans les coordonnées de sa surface puis projeté : un
 * défilement ou un zoom l'emporte d'un bloc avec ce qu'il désigne, seul son
 * propre mouvement glisse.
 */
function PeerCursor({
    surface,
    x,
    y,
    kind,
    color,
    username,
    text
}: {
    surface: CursorSurface;
    x: number;
    y: number;
    kind: LiveCursorKind;
    color: UserColor;
    username: string;
    text: string | null;
}) {
    const glyph = CURSOR_GLYPHS[kind];
    const glidingX = useSpring(x, GLIDE);
    const glidingY = useSpring(y, GLIDE);
    useEffect(() => {
        glidingX.set(x);
        glidingY.set(y);
    }, [glidingX, glidingY, x, y]);
    const moves = useMotionValue(0);
    useEffect(() => surface.subscribe(() => moves.set(moves.get() + 1)), [surface, moves]);
    // Le dernier point montré, si la surface cesse un instant de montrer le point glissant.
    const shown = useRef({ x: 0, y: 0 });
    const at = useTransform(() => {
        moves.get();
        shown.current = surface.toScreen(glidingX.get(), glidingY.get()) ?? shown.current;
        return shown.current;
    });
    const left = useTransform(at, (p) => p.x);
    const top = useTransform(at, (p) => p.y);

    return (
        <motion.div
            className={styles.cursor}
            style={
                {
                    x: left,
                    y: top,
                    // Le point chaud du dessin (pointe de flèche, bout du doigt)
                    // doit tomber sur la position reçue.
                    marginLeft: -glyph.offsetX,
                    marginTop: -glyph.offsetY,
                    '--peer': userColorVar(color)
                } as MotionStyle
            }
        >
            <svg
                className={styles.glyph}
                width={glyph.width}
                height={glyph.height}
                viewBox={glyph.viewBox}
                fill='currentColor'
            >
                {glyph.shape}
            </svg>
            <div className={styles.stack} style={{ marginTop: glyph.labelOffset }}>
                <span className={styles.label}>{username}</span>
                {text !== null && <span className={styles.bubble}>{text}</span>}
            </div>
        </motion.div>
    );
}

export function LiveCursors() {
    const { cursors, cursorChannel } = useLive();
    const says = useSays();
    const { user } = useAuth();
    const workspace = useActiveWorkspace();
    const surface = useLiveSurface();
    useSurfaceChanges(surface);
    const hidden = useHideLiveCursors();

    // Les sorties sont ici, après les hooks, que React n'admet pas conditionnels.
    if (!surface || !workspace || hidden || cursors.length === 0 || cursorChannel !== surface.channel) return null;
    // Un espace personnel est une salle d'une personne ; un canal, lui, réunit
    // aussi des pairs venus d'autres espaces.
    if (surface.channel === null && workspace.kind === 'personal') return null;

    const members = new Map((workspace.users ?? []).map((u) => [u.id, u]));
    // La bulle est jointe au curseur par la connexion : elle n'existe donc que là
    // où un curseur est dessiné, et disparaît avec lui.
    const texts = new Map(says.map((s) => [s.connId, s.text]));

    // Le cadre est la fenêtre, jamais la surface.
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;

    const visible = cursors.filter((entry) => {
        // Mes propres autres onglets : c'est moi, ça n'apprend rien.
        if (user && entry.userId === user.id) return false;
        const at = surface.toScreen(entry.cursor.x, entry.cursor.y);
        return at !== null && at.y >= 0 && at.y <= viewHeight && at.x >= 0 && at.x <= viewWidth;
    });

    if (visible.length === 0) return null;

    return createPortal(
        <div className={styles.layer} aria-hidden='true'>
            {visible.map((entry) => (
                <PeerCursor
                    // Une autre surface est un autre repère : rien à interpoler de l'une à l'autre.
                    key={`${surface.channel ?? ''}|${entry.connId}`}
                    surface={surface}
                    x={entry.cursor.x}
                    y={entry.cursor.y}
                    kind={entry.cursor.kind}
                    color={entry.color}
                    // Un pair de canal peut venir d'un autre espace : son pseudo voyage avec lui.
                    username={entry.name ?? members.get(entry.userId)?.username ?? 'Membre'}
                    text={texts.get(entry.connId) ?? null}
                />
            ))}
        </div>,
        document.body
    );
}
