import { useCallback, useEffect, useRef, useState } from 'react';

import styles from './style.module.css';

import type { NoteBlock } from 'deveye-types';

interface BlockEditorProps {
    blocks: NoteBlock[];
    onChange: (blocks: NoteBlock[]) => void;
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
 *
 * Rows can be reordered by dragging the grip on the left. The list itself never
 * reflows during a drag (that would move the element under the cursor and cause
 * a feedback loop / flicker); instead the dragged row is ghosted and a thin
 * insertion line shows where it will land, computed from each row's midpoint.
 */
export default function BlockEditor({ blocks, onChange }: BlockEditorProps) {
    const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
    const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
    const focusIndex = useRef<number | null>(null);
    // Index of the row being dragged, and the insertion index it would drop at
    // (0..blocks.length). Both null when not dragging.
    const [dragFrom, setDragFrom] = useState<number | null>(null);
    const [dropAt, setDropAt] = useState<number | null>(null);

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

    // Which gap (0..length) the cursor is closest to, from the rows' real
    // geometry. The list doesn't reflow mid-drag, so these rects are stable.
    const insertionIndexAt = useCallback((clientY: number): number => {
        let i = 0;
        for (; i < rowRefs.current.length; i++) {
            const el = rowRefs.current[i];
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) return i;
        }
        return i;
    }, []);

    const onContainerDragOver = useCallback(
        (e: React.DragEvent) => {
            if (dragFrom === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropAt(insertionIndexAt(e.clientY));
        },
        [dragFrom, insertionIndexAt]
    );

    const onContainerDrop = useCallback(
        (e: React.DragEvent) => {
            if (dragFrom === null || dropAt === null) {
                setDragFrom(null);
                setDropAt(null);
                return;
            }
            e.preventDefault();
            // Translate the insertion gap into a target array position.
            const next = [...blocks];
            const [moved] = next.splice(dragFrom, 1);
            const target = dropAt > dragFrom ? dropAt - 1 : dropAt;
            next.splice(target, 0, moved);
            setDragFrom(null);
            setDropAt(null);
            if (target !== dragFrom) onChange(next);
        },
        [blocks, dragFrom, dropAt, onChange]
    );

    // The drop would change nothing if the row lands back in its own slot
    // (gap just above or just below itself) — hide the line in that case.
    const lineAt = (gap: number): boolean =>
        dragFrom !== null && dropAt === gap && dropAt !== dragFrom && dropAt !== dragFrom + 1;

    return (
        <div className={styles.blocks} onDragOver={onContainerDragOver} onDrop={onContainerDrop}>
            {blocks.map((block, index) => (
                <div
                    key={index}
                    ref={(el) => {
                        rowRefs.current[index] = el;
                    }}
                    className={`${styles.block} ${dragFrom === index ? styles.blockDragging : ''}`}
                >
                    {/* Insertion line in the gap above this row. The last row
                        also carries the "drop at end" line on its bottom edge. */}
                    {lineAt(index) && <span className={styles.dropLine} aria-hidden='true' />}
                    {index === blocks.length - 1 && lineAt(blocks.length) && (
                        <span className={`${styles.dropLine} ${styles.dropLineEnd}`} aria-hidden='true' />
                    )}
                    <button
                        type='button'
                        className={styles.blockGrip}
                        aria-label='Réordonner la ligne'
                        draggable
                        onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', String(index));
                            setDragFrom(index);
                            setDropAt(index);
                        }}
                        onDragEnd={() => {
                            setDragFrom(null);
                            setDropAt(null);
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
            ))}

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
