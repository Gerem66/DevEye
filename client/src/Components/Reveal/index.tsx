import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

const REVEAL = { duration: 0.25, ease: [0.22, 1, 0.36, 1] } as const;

interface RevealProps {
    open: boolean;
    children: ReactNode;
}

/**
 * Un bloc qui n'a de sens que dans un état (des rangées sous la protection
 * qui les commande, une barre d'actions tant qu'une sélection existe) : il se
 * déplie quand l'état arrive et se replie quand il part, au lieu d'apparaître
 * d'un coup. Le débordement n'est masqué que pendant le geste, pour ne pas
 * rogner le liseré de focus d'une commande au repos.
 */
export function Reveal({ open, children }: RevealProps) {
    const reduced = useReducedMotion() === true;
    const [settled, setSettled] = useState(true);
    return (
        <AnimatePresence initial={false}>
            {open && (
                <motion.div
                    style={{ overflow: settled ? 'visible' : 'hidden' }}
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={reduced ? { duration: 0 } : REVEAL}
                    onAnimationStart={() => setSettled(false)}
                    onAnimationComplete={() => setSettled(true)}
                >
                    {children}
                </motion.div>
            )}
        </AnimatePresence>
    );
}

export default Reveal;
