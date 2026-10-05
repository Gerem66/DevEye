import React from 'react';

import styles from './style.module.css';

import type { DetailedHTMLProps, TextareaHTMLAttributes } from 'react';

type CustomHTMLProps = DetailedHTMLProps<TextareaHTMLAttributes<HTMLTextAreaElement>, HTMLTextAreaElement>;
type TextAreaProps = CustomHTMLProps & {
    /** La hauteur suit le contenu dès une ligne : tout se lit, rien ne se tire à la main. */
    autoGrow?: boolean;
    error?: string;
};

/**
 * Le champ de plusieurs lignes, de la même peau que `TextInput`. La hauteur se
 * calcule ici plutôt que par `field-sizing: content`, que Firefox ignore.
 */
const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>((props, ref) => {
    const { autoGrow, error, className, rows, onInput, ...rest } = props;
    const own = React.useRef<HTMLTextAreaElement | null>(null);

    const setRef = React.useCallback(
        (node: HTMLTextAreaElement | null) => {
            own.current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) ref.current = node;
        },
        [ref]
    );

    const fit = React.useCallback(() => {
        const node = own.current;
        if (!autoGrow || node === null) return;
        node.style.height = 'auto';
        // `border-box` : la hauteur reprend les deux bordures, que `scrollHeight` ignore.
        node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`;
    }, [autoGrow]);

    React.useLayoutEffect(fit, [fit, rest.value]);

    // Une largeur qui change replie le texte autrement. La hauteur seule ne
    // relance rien : c'est ce calcul qui la pose.
    React.useEffect(() => {
        const node = own.current;
        if (!autoGrow || node === null) return;
        let width = node.clientWidth;
        const observer = new ResizeObserver(() => {
            if (node.clientWidth === width) return;
            width = node.clientWidth;
            fit();
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [autoGrow, fit]);

    const classes = `${styles.textarea} ${autoGrow ? styles.autoGrow : ''} ${className || ''} ${
        error ? styles.error : ''
    }`;

    return (
        <textarea
            ref={setRef}
            className={classes}
            rows={rows ?? (autoGrow ? 1 : 3)}
            onInput={(event) => {
                fit();
                onInput?.(event);
            }}
            {...rest}
        />
    );
});

TextArea.displayName = 'TextArea';

export default TextArea;
