import { useCallback, useEffect, useRef } from 'react';

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
 */
export default function BlockEditor({ blocks, onChange }: BlockEditorProps) {
    const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
    const focusIndex = useRef<number | null>(null);

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
            if (e.key === 'Enter' && !e.shiftKey) {
                // Enter ends the current line and starts a sibling block (same kind,
                // checkboxes start unchecked). Shift+Enter keeps the soft newline.
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

    return (
        <div className={styles.blocks}>
            {blocks.map((block, index) => (
                <div key={index} className={styles.block}>
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
