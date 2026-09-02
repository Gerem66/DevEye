import { SAY_MAX_LENGTH, SAY_MAX_LINES } from '@deveye/types';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import { useAuth } from '@/auth/AuthProvider';
import { useDismissLayer } from '@/Components/Dialog/dismissLayer';
import { userColorVar } from '@/Features/Profile/userColors';
import { useLivePresence } from '@/stores/live';
import { useActiveWorkspace } from '@/stores/workspace';
import { closeCursorChat, lastPointer, setCursorChatText, useCursorChat } from './cursorChat';
import { useHideLiveCursors } from './hideCursors';
import styles from './CursorChatInput.module.css';

/**
 * Ma propre bulle, suspendue à mon curseur et suivie par lui. Ce que je tape
 * part en direct aux pairs situés au même endroit ; je le vois donc comme eux.
 *
 * Rendue à côté de `LiveCursors` et non dedans : celui-ci sort tôt quand aucun
 * pair n'est là, alors qu'une saisie ouverte doit survivre au départ du dernier.
 */

/** Décalage sous la pointe du curseur, pour ne pas écrire sous sa propre main. */
const OFFSET_X = 14;
const OFFSET_Y = 22;

/**
 * Ajuste la hauteur au contenu. `scrollHeight` ignore les bordures, que
 * `border-box` compte dans la hauteur : les rajouter évite de rogner une ligne
 * à chaque repli.
 */
function fitToContent(el: HTMLTextAreaElement | null): void {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

export function CursorChatInput() {
    const { open, text } = useCursorChat();
    const { user } = useAuth();
    const workspace = useActiveWorkspace();
    const hidden = useHideLiveCursors();
    const { path } = useLivePresence();
    /**
     * Où le pointeur est allé depuis l'ouverture, ou `null` tant qu'il n'a pas
     * bougé. Dans ce cas la position est lue au rendu et non recopiée par un
     * effet : un effet ne s'exécute qu'après la première image, qui porterait
     * alors la position de la fermeture précédente et sauterait ici ensuite.
     */
    const [moved, setMoved] = useState<{ x: number; y: number } | null>(null);
    const point = moved ?? lastPointer();
    const field = useRef<HTMLTextAreaElement>(null);

    useDismissLayer(open, closeCursorChat);

    // Avant la peinture : une hauteur ajustée après coup ferait sauter la boîte
    // d'une ligne à l'autre.
    useLayoutEffect(() => {
        if (open) fitToContent(field.current);
    }, [open, text]);

    // Le serveur efface ma bulle dès que je change de lieu : la saisie qui la
    // portait n'aurait plus de destinataire.
    const place = path.join(' ');
    useEffect(() => {
        closeCursorChat();
    }, [place, workspace?.id]);

    useEffect(() => {
        if (!open) return;
        if (hidden) {
            closeCursorChat();
            return;
        }
        field.current?.focus();

        let frame: number | null = null;
        const onMove = (e: PointerEvent): void => {
            if (e.pointerType !== 'mouse') return;
            if (frame !== null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                setMoved({ x: e.clientX, y: e.clientY });
            });
        };
        window.addEventListener('pointermove', onMove, { passive: true });
        return () => {
            window.removeEventListener('pointermove', onMove);
            if (frame !== null) cancelAnimationFrame(frame);
            // Oublier le trajet : la prochaine ouverture repart du pointeur du
            // moment, et non de là où la saisie s'est fermée.
            setMoved(null);
        };
    }, [open, hidden]);

    if (!open || hidden || !user || !workspace || workspace.kind === 'personal') return null;

    return createPortal(
        <div className={styles.layer}>
            <div
                className={styles.anchor}
                style={
                    {
                        transform: `translate(${point.x + OFFSET_X}px, ${point.y + OFFSET_Y}px)`,
                        '--mine': userColorVar(user.color)
                    } as CSSProperties
                }
            >
                <textarea
                    ref={field}
                    className={styles.field}
                    // Une seule ligne au départ : la hauteur suit ensuite le texte.
                    rows={1}
                    value={text}
                    maxLength={SAY_MAX_LENGTH}
                    placeholder='Écrire ici…'
                    aria-label='Écrire au curseur'
                    autoComplete='off'
                    spellCheck={false}
                    onChange={(e) => setCursorChatText(e.target.value)}
                    // La ligne de trop est refusée à la frappe, et pas seulement
                    // ramenée après coup : le magasin ne verrait aucun changement
                    // à annoncer, et le retour resterait dans le DOM.
                    onKeyDown={(e) => {
                        if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
                        if (text.split('\n').length >= SAY_MAX_LINES) e.preventDefault();
                    }}
                    // Cliquer ailleurs prend le clavier : une bulle qu'on ne peut
                    // plus modifier mais que les pairs voient encore serait un piège.
                    onBlur={() => closeCursorChat()}
                />
            </div>
        </div>,
        document.body
    );
}
