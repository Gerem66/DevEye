import { useCallback, useEffect, useRef, useState } from 'react';

import styles from './style.module.css';

import type { NoteBlock } from 'deveye-types';

interface BlockEditorProps {
    blocks: NoteBlock[];
    onChange: (blocks: NoteBlock[]) => void;
}

// A 1×1 transparent image used to suppress the browser's native drag ghost,
// so only our live in-list preview is visible. Created lazily on first drag.
let _emptyDragImage: HTMLImageElement | null = null;
function emptyDragImage(): HTMLImageElement {
    if (!_emptyDragImage) {
        _emptyDragImage = new Image();
        _emptyDragImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    }
    return _emptyDragImage;
}

/** Auto-grow a textarea to fit its content (no inner scrollbar). */
function autosize(el: HTMLTextAreaElement | null): void {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
}

/**
 * The modular note body: an ordered list of typed blocks (paragraph or
 * checklist item). One clean surface — Enter splits into a new block of the
 * same kind, Backspace at the start of an empty block removes it and focuses the
 * previous one, so it reads like a native notes editor rather than a form.
 */
export default function BlockEditor({ blocks, onChange }: BlockEditorProps) {
    const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
    const focusIndex = useRef<number | null>(null);
    // Index of the block being dragged, and the index it would drop before
    // (== blocks.length to drop at the end). Both null when not dragging.
    const [dragFrom, setDragFrom] = useState<number | null>(null);
    const [dragOver, setDragOver] = useState<number | null>(null);

    // After a structural change we may want to move focus to a specific block.
    useEffect(() => {
        if (focusIndex.current === null) return;
        const el = refs.current[focusIndex.current];
        if (el) {
            el.focus();
            const end = el.value.length;
            el.setSelectionRange(end, end);
            autosize(el);
        }
        focusIndex.current = null;
    });

    const update = useCallback(
        (index: number, patch: Partial<NoteBlock>) => {
            onChange(blocks.map((b, i) => (i === index ? ({ ...b, ...patch } as NoteBlock) : b)));
        },
        [blocks, onChange]
    );

    const toggleDone = useCallback(
        (index: number) => {
            const b = blocks[index];
            if (b.type !== 'check') return;
            update(index, { done: !b.done });
        },
        [blocks, update]
    );

    const insertAfter = useCallback(
        (index: number, block: NoteBlock) => {
            const next = [...blocks.slice(0, index + 1), block, ...blocks.slice(index + 1)];
            focusIndex.current = index + 1;
            onChange(next);
        },
        [blocks, onChange]
    );

    const removeAt = useCallback(
        (index: number) => {
            const next = blocks.filter((_, i) => i !== index);
            focusIndex.current = Math.max(0, index - 1);
            onChange(next);
        },
        [blocks, onChange]
    );

    /** Move the block at `from` so it sits before position `to`. */
    const reorder = useCallback(
        (from: number, to: number) => {
            if (from === to || from === to - 1) return;
            const next = [...blocks];
            const [moved] = next.splice(from, 1);
            // Removing the source shifts everything after it left by one.
            next.splice(to > from ? to - 1 : to, 0, moved);
            onChange(next);
        },
        [blocks, onChange]
    );

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLTextAreaElement>, index: number) => {
            const b = blocks[index];
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                // Ctrl+Enter (or ⌘+Enter on Mac) creates a sibling block.
                e.preventDefault();
                insertAfter(
                    index,
                    b.type === 'check' ? { type: 'check', text: '', done: false } : { type: 'text', text: '' }
                );
                return;
            }
            if (e.key === 'Backspace' && b.text === '' && blocks.length > 1) {
                e.preventDefault();
                removeAt(index);
            }
        },
        [blocks, insertAfter, removeAt]
    );

    // Live preview order: while dragging, render the blocks as they *would* be
    // after the drop, so the dragged row glides into place (rendered semi-
    // transparent) instead of a static drop marker. Each entry is the block's
    // original index, used as a stable React key so the DOM node — and its
    // textarea focus/scroll — moves with the block rather than the position.
    const order = blocks.map((_, i) => i);
    if (dragFrom !== null && dragOver !== null && dragOver !== dragFrom && dragOver !== dragFrom + 1) {
        order.splice(dragFrom, 1);
        order.splice(dragOver > dragFrom ? dragOver - 1 : dragOver, 0, dragFrom);
    }

    const commitDrop = (e: React.DragEvent) => {
        if (dragFrom === null || dragOver === null) return;
        e.preventDefault();
        reorder(dragFrom, dragOver);
        setDragFrom(null);
        setDragOver(null);
    };

    const trackDragOver = (e: React.DragEvent, index: number) => {
        if (dragFrom === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // Drop before this block, or after it if past its midpoint.
        const rect = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        setDragOver(after ? index + 1 : index);
    };

    return (
        <div className={styles.blocks} onDrop={commitDrop}>
            {order.map((index) => {
                const block = blocks[index];
                return (
                    <div
                        key={index}
                        className={`${styles.block} ${dragFrom === index ? styles.blockDragging : ''}`}
                        onDragOver={(e) => trackDragOver(e, index)}
                        onDrop={commitDrop}
                    >
                        <button
                            type='button'
                            className={styles.blockGrip}
                            aria-label='Réordonner la ligne'
                            draggable
                            onDragStart={(e) => {
                                e.dataTransfer.effectAllowed = 'move';
                                e.dataTransfer.setData('text/plain', String(index));
                                // Hide the native drag image — the live preview (the
                                // row gliding into place) is our ghost instead.
                                e.dataTransfer.setDragImage(emptyDragImage(), 0, 0);
                                setDragFrom(index);
                            }}
                            onDragEnd={() => {
                                setDragFrom(null);
                                setDragOver(null);
                            }}
                        >
                            <span className={`icon ${styles.badge} icon-drag`} />
                        </button>
                        {block.type === 'check' && (
                            <button
                                type='button'
                                className={`${styles.checkButton} ${block.done ? styles.checkButtonDone : ''}`}
                                aria-label={block.done ? 'Décocher' : 'Cocher'}
                                onClick={() => toggleDone(index)}
                            >
                                <span
                                    className={`icon ${styles.badge} icon-${block.done ? 'square-check' : 'square-empty'}`}
                                />
                            </button>
                        )}
                        <textarea
                            ref={(el) => {
                                refs.current[index] = el;
                                autosize(el);
                            }}
                            className={`${styles.blockText} ${
                                block.type === 'check' && block.done ? styles.blockTextDone : ''
                            }`}
                            rows={1}
                            value={block.text}
                            placeholder={block.type === 'check' ? 'Élément…' : 'Écrivez quelque chose…'}
                            onChange={(e) => {
                                update(index, { text: e.target.value });
                                autosize(e.target);
                            }}
                            onKeyDown={(e) => onKeyDown(e, index)}
                        />
                        <button
                            type='button'
                            className={styles.blockRemove}
                            aria-label='Supprimer la ligne'
                            onClick={() => removeAt(index)}
                            disabled={blocks.length <= 1}
                        >
                            <span className={`icon ${styles.badge} icon-x`} />
                        </button>
                    </div>
                );
            })}

            <div className={styles.addBlockRow}>
                <button
                    type='button'
                    className={styles.addBlockBtn}
                    onClick={() => insertAfter(blocks.length - 1, { type: 'text', text: '' })}
                >
                    <span className={`icon ${styles.toggleIcon} icon-add`} /> Paragraphe
                </button>
                <button
                    type='button'
                    className={styles.addBlockBtn}
                    onClick={() => insertAfter(blocks.length - 1, { type: 'check', text: '', done: false })}
                >
                    <span className={`icon ${styles.toggleIcon} icon-square-empty`} /> Case à cocher
                </button>
            </div>
        </div>
    );
}
