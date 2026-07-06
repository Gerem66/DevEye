import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';

import styles from './style.module.css';
import { inlineToEditorHtml, type MarkClasses } from './markdown';

/** Imperative handle the editor uses to read/move the caret of a block. */
export interface RichTextHandle {
    focus(): void;
    /** Caret character offsets within the block's plain text. */
    getCaret(): { start: number; end: number };
    /** Place the caret (or a selection) by plain-text offset. */
    setCaret(start: number, end?: number): void;
}

interface RichTextProps {
    /** The block's plain text (markdown markers included). */
    value: string;
    className?: string;
    placeholder?: string;
    onChange: (value: string) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
    onFocus?: () => void;
}

const MARK_CLASSES: MarkClasses = {
    marker: styles.mdMarker,
    bold: styles.mdBold,
    italic: styles.mdItalic,
    underline: styles.mdUnderline,
    strike: styles.mdStrike,
    color: styles.mdColor
};

/** Total text length of the caret position `node`/`offset` relative to `root`. */
function offsetWithin(root: HTMLElement, node: Node, nodeOffset: number): number {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, nodeOffset);
    return range.toString().length;
}

/** Resolve a plain-text offset back to a (text node, offset) pair inside `root`. */
function locate(root: HTMLElement, target: number): { node: Node; offset: number } {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let remaining = target;
    let last: Node = root;
    let node = walker.nextNode();
    while (node) {
        const len = node.textContent?.length ?? 0;
        if (remaining <= len) return { node, offset: remaining };
        remaining -= len;
        last = node;
        node = walker.nextNode();
    }
    return { node: last, offset: last.textContent?.length ?? 0 };
}

/**
 * A contentEditable surface that renders inline markdown live: the markers stay
 * visible but dimmed while the marked text is styled. Because the rendered
 * content's text equals the source character-for-character, the caret maps to a
 * plain offset — so the editor's key handling can stay offset-based, like a
 * textarea's selectionStart/End.
 *
 * The DOM is owned imperatively (innerHTML set on every value change, caret
 * restored by offset) rather than by React, which is what lets the formatting
 * re-render under the caret without it jumping.
 */
const RichText = forwardRef<RichTextHandle, RichTextProps>(function RichText(
    { value, className, placeholder, onChange, onKeyDown, onFocus },
    ref
) {
    const elRef = useRef<HTMLDivElement>(null);
    /** Caret offsets to restore right after the next innerHTML render. */
    const pendingCaret = useRef<{ start: number; end: number } | null>(null);

    const html = useMemo(() => inlineToEditorHtml(value, MARK_CLASSES), [value]);

    useImperativeHandle(
        ref,
        () => ({
            focus() {
                elRef.current?.focus();
            },
            getCaret() {
                const el = elRef.current;
                const sel = window.getSelection();
                if (!el || !sel || sel.rangeCount === 0) return { start: 0, end: 0 };
                const range = sel.getRangeAt(0);
                if (!el.contains(range.startContainer)) return { start: 0, end: 0 };
                return {
                    start: offsetWithin(el, range.startContainer, range.startOffset),
                    end: offsetWithin(el, range.endContainer, range.endOffset)
                };
            },
            setCaret(start, end = start) {
                const el = elRef.current;
                const sel = window.getSelection();
                if (!el || !sel) return;
                const a = locate(el, start);
                const b = end === start ? a : locate(el, end);
                const range = document.createRange();
                range.setStart(a.node, a.offset);
                range.setEnd(b.node, b.offset);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }),
        []
    );

    // Re-render the formatted HTML whenever the value changes, then restore the
    // caret captured at input time (only while this surface holds focus).
    useLayoutEffect(() => {
        const el = elRef.current;
        if (!el) return;
        el.innerHTML = html;
        if (pendingCaret.current && document.activeElement === el) {
            const { start, end } = pendingCaret.current;
            const a = locate(el, start);
            const b = end === start ? a : locate(el, end);
            const sel = window.getSelection();
            if (sel) {
                const range = document.createRange();
                range.setStart(a.node, a.offset);
                range.setEnd(b.node, b.offset);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }
        pendingCaret.current = null;
    }, [html]);

    const handleInput = () => {
        const el = elRef.current;
        if (!el) return;
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).endContainer)) {
            const range = sel.getRangeAt(0);
            pendingCaret.current = {
                start: offsetWithin(el, range.startContainer, range.startOffset),
                end: offsetWithin(el, range.endContainer, range.endOffset)
            };
        }
        onChange(el.textContent ?? '');
    };

    return (
        <div
            ref={elRef}
            className={className}
            contentEditable
            suppressContentEditableWarning
            role='textbox'
            aria-multiline='true'
            data-empty={value === '' ? 'true' : undefined}
            data-placeholder={placeholder}
            onInput={handleInput}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
        />
    );
});

export default RichText;
