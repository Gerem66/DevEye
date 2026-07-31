import { useRef, useState } from 'react';

import styles from './style.module.css';

import Popup, { ClosePopup, OpenPopup } from '@/Components/Popup';
import { DialogCancelButton } from '@/Components/Dialog';
import { openInfo } from '@/Components/InfoPopup';
import Button from '@/Components/Button';
import BlockEditor from './BlockEditor';
import { exportNotePdf } from './exportPdf';
import { NOTE_CONFIRM_POPUP, type ConfirmInput } from './ConfirmPopup';

import { NOTE_TITLE_MAX_LENGTH, type Note, type NoteBlock } from 'deveye-types';

export const NOTE_EDITOR_POPUP = 'popup-note-editor';

/** The editable subset of a note returned by the editor on save. */
export interface NoteDraft {
    title: string;
    folderId: number | null;
    blocks: NoteBlock[];
    /** Encrypt with the password-protected key instead of the open one. */
    private: boolean;
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

/** Date only (no time) — used for the PDF's neutral metadata line. */
function formatDate(time: number): string {
    return new Date(time * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Drop empty text blocks but keep structural ones (dividers). */
function normalizeBlocks(blocks: NoteBlock[]): NoteBlock[] {
    return blocks.filter((b) => b.type === 'divider' || b.text.trim() !== '');
}

/** Open the shared, root-level explainer about private notes. */
function showPrivateInfo() {
    void openInfo({
        title: 'Notes privées',
        body: (
            <>
                <p>
                    Une note ordinaire est chiffrée avec une clé que le serveur sait déballer seul : elle s’ouvre sans
                    aucune saisie. Une note <strong>privée</strong> est chiffrée avec la clé dérivée de votre mot de
                    passe — tant que la session n’est pas déverrouillée, son titre comme son contenu restent illisibles,
                    y compris pour le serveur.
                </p>
                <p>
                    Dans la liste, une note privée verrouillée s’affiche avec un cadenas ; « Déchiffrer » demande votre
                    mot de passe et les révèle toutes d’un coup. Basculer ce réglage re-chiffre la note à
                    l’enregistrement.
                </p>
            </>
        )
    });
}

/**
 * The single note editor surface, driven imperatively via OpenPopup. Handles
 * both create and edit: a prominent title, the modular block body, and an
 * understated "private" toggle. The note's folder and position are set from the
 * main screen. Deletion is confirmed via a popup over the editor; the editor only
 * closes once confirmed.
 */
export default function NoteEditor() {
    const [mode, setMode] = useState<'add' | 'edit'>('add');
    const [title, setTitle] = useState('');
    const [folderId, setFolderId] = useState<number | null>(null);
    const [blocks, setBlocks] = useState<NoteBlock[]>(emptyBlocks);
    /** Whether the note will be encrypted with the password-protected key. */
    const [isPrivate, setIsPrivate] = useState(false);
    const [created, setCreated] = useState<number | null>(null);
    const [updated, setUpdated] = useState<number | null>(null);
    // Snapshot of the editable state the editor opened with, to detect unsaved
    // edits (blocks compared structurally).
    const initial = useRef({ title: '', private: false, blocks: '' });

    function handleOpen(input: NoteEditorInput) {
        const note = input?.note ?? null;
        if (!note) {
            setMode('add');
            setTitle('');
            setFolderId(input?.folderId ?? null);
            setBlocks(emptyBlocks());
            setIsPrivate(false);
            setCreated(null);
            setUpdated(null);
            initial.current = { title: '', private: false, blocks: JSON.stringify(emptyBlocks()) };
            return;
        }
        setMode('edit');
        setTitle(note.title);
        setFolderId(note.folderId);
        const openBlocks = note.blocks.length > 0 ? note.blocks : emptyBlocks();
        setBlocks(openBlocks);
        setIsPrivate(note.private);
        setCreated(note.created);
        setUpdated(note.updated);
        initial.current = { title: note.title, private: note.private, blocks: JSON.stringify(openBlocks) };
    }

    const dirty =
        title !== initial.current.title ||
        isPrivate !== initial.current.private ||
        JSON.stringify(blocks) !== initial.current.blocks;

    function close(result: NoteEditorResult = null) {
        ClosePopup(NOTE_EDITOR_POPUP, result);
    }

    function save() {
        const draft: NoteDraft = {
            title: title.trim(),
            folderId,
            blocks: normalizeBlocks(blocks),
            private: isPrivate
        };
        // An entirely empty note (no title and no content) is a no-op cancel
        // rather than persisting a blank row.
        if (draft.title === '' && draft.blocks.length === 0) {
            close(null);
            return;
        }
        close(draft);
    }

    /** Confirm deletion in a popup over the editor; only close once confirmed. */
    async function requestDelete() {
        const confirmed = await OpenPopup<boolean>(NOTE_CONFIRM_POPUP, {
            title: 'Supprimer la note',
            message: `Supprimer « ${title.trim() || 'Sans titre'} » ? Elle part dans les archives, d’où vous pourrez la restaurer ou la supprimer définitivement.`,
            confirmLabel: 'Supprimer'
        } as ConfirmInput);
        if (confirmed === true) close('delete');
    }

    // Past ~10 lines of content the compact dialog gets cramped, so the editor
    // switches — in one step — to a large, feature-sized surface: a fixed tall
    // popup whose title and footer stay pinned while only the block list scrolls.
    // It snaps back to the compact size once the content drops below again.
    const lineCount = blocks.reduce(
        (n, b) => n + (b.type === 'divider' ? 1 : Math.max(1, b.text.split('\n').length)),
        0
    );
    const expanded = lineCount > 10;
    const editorWidth = expanded ? 960 : 560;

    return (
        <Popup<NoteEditorInput>
            id={NOTE_EDITOR_POPUP}
            title=''
            width={editorWidth}
            onInputChange={handleOpen}
            onClosePopup={() => close(null)}
            onSubmit={save}
            dirty={dirty}
            onSave={save}
            tall={expanded}
            headerAction={
                <button
                    type='button'
                    className={styles.editorInfoBtn}
                    aria-label='À propos des notes privées'
                    title='Comment fonctionnent les notes privées ?'
                    onClick={showPrivateInfo}
                >
                    <span className='icon icon-info' />
                </button>
            }
        >
            <div className={`${styles.editor} ${expanded ? styles.editorFill : ''}`}>
                <input
                    className={styles.editorTitleInput}
                    placeholder={mode === 'add' ? 'Titre de la nouvelle note' : 'Titre de la note'}
                    value={title}
                    maxLength={NOTE_TITLE_MAX_LENGTH}
                    onChange={(e) => setTitle(e.target.value)}
                />

                <hr className={styles.divider} />

                <BlockEditor
                    blocks={blocks}
                    onChange={setBlocks}
                    fill={expanded}
                    notice={
                        isPrivate !== initial.current.private ? (
                            <p className={styles.privateNotice}>
                                <span className={`icon ${styles.toggleIcon} icon-${isPrivate ? 'lock' : 'unlock'}`} />
                                {isPrivate
                                    ? 'La note sera re-chiffrée avec votre mot de passe à l’enregistrement.'
                                    : 'La note sera lisible sans mot de passe après l’enregistrement.'}
                            </p>
                        ) : undefined
                    }
                    footerActions={
                        <>
                            {mode === 'edit' && (
                                <button
                                    type='button'
                                    className={styles.iconAction}
                                    aria-label='Supprimer la note'
                                    title='Supprimer la note'
                                    onClick={() => void requestDelete()}
                                >
                                    <span className={`icon ${styles.toggleIcon} icon-trash`} />
                                </button>
                            )}
                            <button
                                type='button'
                                className={`${styles.iconToggle} ${isPrivate ? styles.iconToggleActive : ''}`}
                                aria-pressed={isPrivate}
                                title={isPrivate ? 'Rendre la note lisible sans mot de passe' : 'Rendre la note privée'}
                                onClick={() => setIsPrivate((v) => !v)}
                            >
                                <span className={`icon ${styles.toggleIcon} icon-${isPrivate ? 'lock' : 'unlock'}`} />
                            </button>
                            <button
                                type='button'
                                className={styles.iconToggle}
                                title='Exporter en PDF'
                                aria-label='Exporter en PDF'
                                onClick={() =>
                                    exportNotePdf(
                                        title,
                                        normalizeBlocks(blocks),
                                        mode === 'edit' && updated !== null
                                            ? `Modifiée le ${formatDate(updated)}`
                                            : undefined
                                    )
                                }
                            >
                                <span className={`icon ${styles.toggleIcon} icon-download`} />
                            </button>
                        </>
                    }
                    footerDates={
                        mode === 'edit' && created !== null && updated !== null ? (
                            <p className={styles.editorDates}>
                                Créée le {formatStamp(created)} · Modifiée le {formatStamp(updated)}
                            </p>
                        ) : undefined
                    }
                    footerButtons={
                        <>
                            <DialogCancelButton>Annuler</DialogCancelButton>
                            <Button onClick={save}>Enregistrer</Button>
                        </>
                    }
                />
            </div>
        </Popup>
    );
}
