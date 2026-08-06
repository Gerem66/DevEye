import { motion } from 'framer-motion';
import { useEffect, useReducer, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import { useAuth } from '@/auth/AuthProvider';
import { userColorVar } from '@/Features/Profile/userColors';
import { useLive } from '@/stores/live';
import { useActiveWorkspace } from '@/stores/workspace';
import { useLiveSurface } from './LiveProvider';
import styles from './LiveCursors.module.css';

/**
 * Les curseurs des pairs qui sont exactement là où nous sommes.
 *
 * Le serveur a déjà fait le tri : il n'envoie de curseurs qu'entre connexions au
 * chemin identique. Il ne reste ici qu'à replacer les coordonnées dans **notre**
 * surface, et à en tirer un pseudo et une couleur.
 *
 * Hors de la boîte visible, le curseur est **masqué** plutôt qu'épinglé au bord :
 * un curseur collé au bord se lit comme quelqu'un qui serait là, et qui n'y est
 * pas.
 */

/**
 * La géométrie de la surface, **lue au rendu et jamais mémorisée**.
 *
 * La tentation est de la mettre en cache et de la rafraîchir sur
 * `ResizeObserver`. C'est faux ici : la popup s'ouvre par un morphe
 * framer-motion (`layoutId`), qui anime un `transform` — lequel ne change pas la
 * boîte de bordure et **ne déclenche donc aucun `ResizeObserver`**. Une mesure
 * prise à l'ouverture reste figée sur la taille de la carte d'origine, et tous
 * les curseurs atterrissent hors cadre, donc invisibles.
 *
 * Lire au rendu est ici à la fois juste et bon marché : ce composant ne rend que
 * lorsqu'un curseur bouge, c'est-à-dire au plus une fois par tic de 50 ms, et
 * c'est précisément l'instant où l'on a besoin d'une mesure fraîche. Les
 * abonnements ci-dessous ne servent qu'à provoquer un rendu quand rien ne bouge
 * côté pairs mais que le cadre, lui, a changé (défilement, redimensionnement).
 */
function useSurfaceGeometry(surface: HTMLElement | null): { rect: DOMRect; scrollTop: number } | null {
    const [, bump] = useReducer((n: number) => n + 1, 0);

    useEffect(() => {
        if (!surface) return;
        const observer = new ResizeObserver(bump);
        observer.observe(surface);
        surface.addEventListener('scroll', bump, { passive: true });
        window.addEventListener('resize', bump);
        return () => {
            observer.disconnect();
            surface.removeEventListener('scroll', bump);
            window.removeEventListener('resize', bump);
        };
    }, [surface]);

    if (!surface) return null;
    return { rect: surface.getBoundingClientRect(), scrollTop: surface.scrollTop };
}

export function LiveCursors() {
    const { cursors, peers } = useLive();
    const { user } = useAuth();
    const workspace = useActiveWorkspace();
    const surface = useLiveSurface();
    const geometry = useSurfaceGeometry(surface);

    // Un espace personnel est une salle d'une personne : rien à afficher.
    if (!geometry || !workspace || workspace.kind === 'personal' || cursors.length === 0) return null;

    const members = new Map((workspace.users ?? []).map((u) => [u.id, u]));
    // La couleur n'est pas répétée dans la trame de curseur : elle est déjà dans
    // le roster, qui arrive avant et se met à jour tout seul quand elle change.
    const colors = new Map(peers.map((p) => [p.connId, p.color]));
    const { rect, scrollTop } = geometry;

    const visible = cursors.flatMap((entry) => {
        // Mes propres autres onglets : c'est moi, ça n'apprend rien.
        if (user && entry.userId === user.id) return [];
        const color = colors.get(entry.connId);
        if (!color) return [];
        const member = members.get(entry.userId);
        const left = rect.left + entry.cursor.x * rect.width;
        const top = rect.top + entry.cursor.y - scrollTop;
        if (top < rect.top || top > rect.bottom || left < rect.left || left > rect.right) return [];
        return [{ ...entry, color, left, top, username: member?.username ?? 'Membre' }];
    });

    if (visible.length === 0) return null;

    return createPortal(
        <div className={styles.layer} aria-hidden='true'>
            {visible.map((c) => (
                <motion.div
                    key={c.connId}
                    className={styles.cursor}
                    // Interpolé : les trames arrivent par paquets de 50 ms, un
                    // saut par trame se lirait comme une saccade plutôt qu'un
                    // mouvement. Un ressort ferme, pour ne pas traîner derrière.
                    initial={false}
                    animate={{ x: c.left, y: c.top }}
                    transition={{ type: 'spring', stiffness: 700, damping: 45, mass: 0.6 }}
                    style={{ '--peer': userColorVar(c.color) } as CSSProperties}
                >
                    <svg className={styles.arrow} viewBox='0 0 14 20' fill='currentColor'>
                        <path
                            d='M1 1 L1 16.5 L5.2 12.6 L7.8 18.6 L10.6 17.4 L8 11.5 L13 11.2 Z'
                            stroke='rgba(0,0,0,0.45)'
                            strokeWidth='1'
                            strokeLinejoin='round'
                        />
                    </svg>
                    <span className={styles.label}>{c.username}</span>
                </motion.div>
            ))}
        </div>,
        document.body
    );
}
