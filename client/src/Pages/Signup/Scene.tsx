import { useLayoutEffect, useRef, type ReactNode } from 'react';

import '@/Pages/Login/style.css';

interface SceneProps {
    /** La carte s'effondre en barre, qui se remplit. */
    collapsing?: boolean;
    /** La scène entière s'efface en fondu. */
    hidden?: boolean;
    onSubmit?: () => void;
    /** Sous la carte : le bouton texte qui ramène à la connexion. */
    footer?: ReactNode;
    children: ReactNode;
}

/** La scène du login, pour l'inscription : c'est le même moment du parcours. */
export function SignupScene({ collapsing = false, hidden = false, onSubmit, footer, children }: SceneProps) {
    const cardRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);

    // La carte épouse la hauteur mesurée de son contenu : elle reste juste
    // d'une étape à l'autre, et `height` reste animable (`auto` ne l'est pas).
    useLayoutEffect(() => {
        const card = cardRef.current;
        const content = contentRef.current;
        if (!card || !content) return;
        const sync = (): void => card.style.setProperty('--card-height', `${content.offsetHeight}px`);
        sync();
        const ro = new ResizeObserver(sync);
        ro.observe(content);
        return () => ro.disconnect();
    }, []);

    return (
        <div className={'login' + (hidden ? ' hide' : '')}>
            <form
                className='form'
                onSubmit={(e) => {
                    e.preventDefault();
                    onSubmit?.();
                }}
            >
                <span className='title'>
                    <b>Dev</b> <p>Eye</p>
                </span>

                <div ref={cardRef} className={'login-card' + (collapsing ? ' card-to-progressbar' : '')}>
                    <div className={'progress-bar' + (collapsing ? ' filling' : '')} />
                    <div ref={contentRef} className='login-card-content'>
                        {children}
                    </div>
                </div>
                {!collapsing && footer}
            </form>
        </div>
    );
}
