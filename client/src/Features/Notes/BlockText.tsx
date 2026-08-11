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
 * One block's text surface, rendering inline markdown live: the markers stay
 * visible but dimmed while the marked text is styled. Because the rendered
 * content's text equals the source character-for-character, the caret maps to a
 * plain offset (see {@link readSelection}).
 *
 * It is *not* an editing host of its own — the whole block list is (see
 * BlockEditor), which is what lets the caret and a selection move freely from
 * one block to the next. It only owns its own HTML: React never renders children
 * here, so a keystroke landing in this element cannot desynchronise React's
 * tree, and re-rendering the formatting under the caret never makes it jump.
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
