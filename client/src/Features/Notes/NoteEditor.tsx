import { useRef, useState } from 'react';

import styles from './style.module.css';

import Popup, { ClosePopup } from '@/Components/Popup';
import Button from '@/Components/Button';
import BlockEditor from './BlockEditor';

import { NOTE_TITLE_MAX_LENGTH, type Note, type NoteBlock } from 'deveye-types';

export const NOTE_EDITOR_POPUP = 'popup-note-editor';

/** The editable subset of a note returned by the editor on save. */
export interface NoteDraft {
    title: string;
    folderId: number | null;
    blocks: NoteBlock[];
    pinned: boolean;
    hidden: boolean;
}

export type NoteEditorResult = NoteDraft | 'delete' | null;

/**
 * Input handed to OpenPopup. `note` is the note to edit (or null to create);
 * `folderId` is the folder a *new* note should be filed into (the section the
 * user clicked "+"); ignored when editing. Folder management lives in the main
 * screen, never in this form.
 */
export interface NoteEditorInput {
    note: Note | null;
    folderId: number | null;
}

function emptyBlocks(): NoteBlock[] {
    return [{ type: 'text', text: '' }];
}

/** Human date+time (epoch seconds) for the editor's metadata line. */
function formatStamp(time: number): string {
    return new Date(time * 1000).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/** Drop trailing empty blocks but always keep at least one. */
function normalizeBlocks(blocks: NoteBlock[]): NoteBlock[] {
    const trimmed = blocks.filter((b) => b.text.trim() !== '');
    return trimmed.length > 0 ? trimmed : [];
}

/**
 * The single note editor surface, driven imperatively via OpenPopup. Handles
 * both create and edit: a prominent title, the modular block body, and two
 * understated pin/hidden toggles (rarely used, so kept visually quiet). The
 * note's folder is set from the main screen, not here. "Hidden" notes need the
 * session revealed first; that gate is enforced by the caller before saving.
 */
export default function NoteEditor() {
    const titleRef = useRef<HTMLInputElement | null>(null);
    const [mode, setMode] = useState<'add' | 'edit'>('add');
    const [title, setTitle] = useState('');
    const [folderId, setFolderId] = useState<number | null>(null);
    const [blocks, setBlocks] = useState<NoteBlock[]>(emptyBlocks);
    const [pinned, setPinned] = useState(false);
    const [hidden, setHidden] = useState(false);
    const [created, setCreated] = useState<number | null>(null);
    const [updated, setUpdated] = useState<number | null>(null);

    function handleOpen(input: NoteEditorInput) {
        const note = input?.note ?? null;
        if (!note) {
            setMode('add');
            setTitle('');
            setFolderId(input?.folderId ?? null);
            setBlocks(emptyBlocks());
            setPinned(false);
            setHidden(false);
            setCreated(null);
            setUpdated(null);
            setTimeout(() => titleRef.current?.focus(), 0);
            return;
        }
        setMode('edit');
        setTitle(note.title);
        setFolderId(note.folderId);
        setBlocks(note.blocks.length > 0 ? note.blocks : emptyBlocks());
        setPinned(note.pinned);
        setHidden(note.hidden);
        setCreated(note.created);
        setUpdated(note.updated);
    }

    function close(result: NoteEditorResult = null) {
        ClosePopup(NOTE_EDITOR_POPUP, result);
    }

    function save() {
        const draft: NoteDraft = {
            title: title.trim(),
            folderId,
            blocks: normalizeBlocks(blocks),
            pinned,
            hidden
        };
        // An entirely empty note (no title and no content) is a no-op cancel
        // rather than persisting a blank row.
        if (draft.title === '' && draft.blocks.length === 0) {
            close(null);
            return;
        }
        close(draft);
    }

    return (
        <Popup<NoteEditorInput>
            id={NOTE_EDITOR_POPUP}
            title=''
            width={560}
            onInputChange={handleOpen}
            onClosePopup={() => close(null)}
        >
            <div className={styles.editor}>
                <input
                    ref={titleRef}
                    className={styles.editorTitleInput}
                    placeholder={mode === 'add' ? 'Titre de la nouvelle note' : 'Titre de la note'}
                    value={title}
                    maxLength={NOTE_TITLE_MAX_LENGTH}
                    onChange={(e) => setTitle(e.target.value)}
                />

                <hr className={styles.divider} />

                <BlockEditor blocks={blocks} onChange={setBlocks} />

                {mode === 'edit' && created !== null && updated !== null && (
                    <p className={styles.editorDates}>
                        <span>Créée le {formatStamp(created)}</span>
                        <span>Modifiée le {formatStamp(updated)}</span>
                    </p>
                )}

                <hr className={styles.divider} />

                <div className={styles.editorFooter}>
                    <div className={styles.footerLeft}>
                        {mode === 'edit' && (
                            <button
                                type='button'
                                className={styles.iconAction}
                                aria-label='Supprimer la note'
                                title='Supprimer la note'
                                onClick={() => close('delete')}
                            >
                                <span className={`icon ${styles.toggleIcon} icon-trash`} />
                            </button>
                        )}
                        <button
                            type='button'
                            className={`${styles.iconToggle} ${pinned ? styles.iconToggleActive : ''}`}
                            aria-pressed={pinned}
                            title={pinned ? 'Désépingler' : 'Épingler'}
                            onClick={() => setPinned((v) => !v)}
                        >
                            <span className={`icon ${styles.toggleIcon} icon-${pinned ? 'star' : 'star-outline'}`} />
                        </button>
                        <button
                            type='button'
                            className={`${styles.iconToggle} ${hidden ? styles.iconToggleActive : ''}`}
                            aria-pressed={hidden}
                            title={hidden ? 'Ne plus masquer' : 'Masquer'}
                            onClick={() => setHidden((v) => !v)}
                        >
                            <span className={`icon ${styles.toggleIcon} icon-lock`} />
                        </button>
                    </div>
                    <div className={styles.footerRight}>
                        <Button variant='secondary' onClick={() => close(null)}>
                            Annuler
                        </Button>
                        <Button onClick={save}>Enregistrer</Button>
                    </div>
                </div>
            </div>
        </Popup>
    );
}
