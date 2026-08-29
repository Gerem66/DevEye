import { useLayoutEffect, useMemo, useRef } from 'react';

import styles from './style.module.css';
import { inlineToEditorHtml, type MarkClasses } from './markdown';

interface BlockTextProps {
    /** The block's plain text (markdown markers included). */
    value: string;
    className?: string;
    placeholder?: string;
}

const MARK_CLASSES: MarkClasses = {
    marker: styles.mdMarker,
    bold: styles.mdBold,
    italic: styles.mdItalic,
    underline: styles.mdUnderline,
    strike: styles.mdStrike,
    color: styles.mdColor
};

/**
 * Renders inline markdown live, markers kept visible but dimmed. The rendered
 * text equals the source character-for-character, so the caret maps to a plain
 * offset (see {@link readSelection}). The editing host is the whole block list
 * (BlockEditor), which lets the caret cross blocks; React never renders children
 * here, so a keystroke landing in this element cannot desynchronise its tree.
 */
export default function BlockText({ value, className, placeholder }: BlockTextProps) {
    const elRef = useRef<HTMLDivElement>(null);
    const html = useMemo(() => inlineToEditorHtml(value, MARK_CLASSES), [value]);

    useLayoutEffect(() => {
        const el = elRef.current;
        if (el && el.innerHTML !== html) el.innerHTML = html;
    }, [html]);

    return (
        <div
            ref={elRef}
            data-text
            className={className}
            data-empty={value === '' ? 'true' : undefined}
            data-placeholder={placeholder}
        />
    );
}
