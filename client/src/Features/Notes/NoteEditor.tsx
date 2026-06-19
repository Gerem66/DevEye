import { useRef, useState } from 'react';

import styles from './style.module.css';

import Popup, { ClosePopup, OpenPopup } from '@/Components/Popup';
import { openInfo } from '@/Components/InfoPopup';
import Button from '@/Components/Button';
import BlockEditor from './BlockEditor';
import { NOTE_LOCK_SET_POPUP, type NoteLockSetInput } from './LockSetPopup';
import { NOTE_LOCK_MANAGE_POPUP, type LockManageResult } from './LockManagePopup';
import { NOTE_CONFIRM_POPUP, type ConfirmInput } from './ConfirmPopup';

import { NOTE_TITLE_MAX_LENGTH, type Note, type NoteBlock } from 'deveye-types';

export const NOTE_EDITOR_POPUP = 'popup-note-editor';

/**
 * How the editor's save should affect the note's lock:
 *  - undefined        → leave the lock unchanged (content-only edit).
 *  - `{ set: pwd }`   → (re)lock the note with this dedicated password.
 *  - `{ remove: true }` → remove the lock (note becomes open).
 */
export type LockChange = { set: string } | { remove: true } | undefined;

/** The editable subset of a note returned by the editor on save. */
export interface NoteDraft {
    title: string;
    folderId: number | null;
    blocks: NoteBlock[];
    pinned: boolean;
    lock: LockChange;
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

/** Open the shared, root-level explainer about locked notes. */
function showLockInfo() {
    void openInfo({
        title: 'Notes verrouillées',
        body: (
            <>
                <p>
                    Une note <strong>verrouillée</strong> possède son propre mot de passe, distinct de celui de votre
                    compte. Elle apparaît avec un cadenas et son titre comme son contenu restent masqués tant que ce mot
                    de passe n’est pas saisi.
                </p>
                <p>
                    Le verrou est un contrôle d’<strong>accès</strong> : il faut le mot de passe pour ouvrir, modifier
                    ou supprimer la note. Le déplacer d’un dossier à l’autre reste libre. Le chiffrement des données en
                    base n’est pas affecté.
                </p>
            </>
        )
    });
}

/**
 * The single note editor surface, driven imperatively via OpenPopup. Handles
 * both create and edit: a prominent title, the modular block body, and an
 * understated pin toggle. The note's folder is set from the main screen.
 *
 * "Verrouiller" gives the note its own dedicated password — an access gate
 * checked server-side on every open/delete (the body's encryption is unchanged).
 * Setting / changing / removing the lock is done through dedicated popups opened
 * over the editor, so the surface stays uncluttered. Deletion is confirmed via a
 * popup over the editor too; the editor only closes once confirmed.
 */
export default function NoteEditor() {
    const titleRef = useRef<HTMLInputElement | null>(null);
    const [mode, setMode] = useState<'add' | 'edit'>('add');
    const [title, setTitle] = useState('');
    const [folderId, setFolderId] = useState<number | null>(null);
    const [blocks, setBlocks] = useState<NoteBlock[]>(emptyBlocks);
    const [pinned, setPinned] = useState(false);
    /** Whether the note is currently locked (was opened with its password). */
    const [wasLocked, setWasLocked] = useState(false);
    /** Pending lock change applied on save; null = leave the lock unchanged. */
    const [lockChange, setLockChange] = useState<LockChange>(undefined);
    const [created, setCreated] = useState<number | null>(null);
    const [updated, setUpdated] = useState<number | null>(null);

    function handleOpen(input: NoteEditorInput) {
        const note = input?.note ?? null;
        setLockChange(undefined);
        if (!note) {
            setMode('add');
            setTitle('');
            setFolderId(input?.folderId ?? null);
            setBlocks(emptyBlocks());
            setPinned(false);
            setWasLocked(false);
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
        setWasLocked(note.locked);
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
            lock: lockChange
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
            message: `Supprimer « ${title.trim() || 'Sans titre'} » ? Cette action est irréversible.`,
            confirmLabel: 'Supprimer'
        } as ConfirmInput);
        if (confirmed === true) close('delete');
    }

    /** Whether the note will be locked after saving (existing lock + pending change). */
    const lockedAfterSave =
        lockChange && 'set' in lockChange ? true : lockChange && 'remove' in lockChange ? false : wasLocked;

    /**
     * Padlock toggle. On a note that will be locked, open the manage popup
     * (Annuler / Changer le mot de passe / Retirer le verrou); otherwise open the
     * set popup to define a password. Opening the editor already proved
     * authorization, so removing the lock needs no password re-check.
     */
    async function toggleLock() {
        if (lockedAfterSave) {
            const action = await OpenPopup<LockManageResult>(NOTE_LOCK_MANAGE_POPUP);
            if (action === 'remove') {
                setLockChange(wasLocked ? { remove: true } : undefined);
            } else if (action === 'change') {
                const pwd = await OpenPopup<string>(NOTE_LOCK_SET_POPUP, { changing: true } as NoteLockSetInput);
                if (pwd !== null) setLockChange({ set: pwd });
            }
            return;
        }
        const pwd = await OpenPopup<string>(NOTE_LOCK_SET_POPUP, { changing: false } as NoteLockSetInput);
        if (pwd !== null) setLockChange({ set: pwd });
    }

    return (
        <Popup<NoteEditorInput>
            id={NOTE_EDITOR_POPUP}
            title=''
            width={560}
            onInputChange={handleOpen}
            onClosePopup={() => close(null)}
            headerAction={
                <button
                    type='button'
                    className={styles.editorInfoBtn}
                    aria-label='À propos des notes verrouillées'
                    title='Comment fonctionnent les notes verrouillées ?'
                    onClick={showLockInfo}
                >
                    <span className='icon icon-info' />
                </button>
            }
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

                {lockChange && 'set' in lockChange && (
                    <p className={styles.lockNotice}>
                        <span className={`icon ${styles.toggleIcon} icon-lock`} />
                        {wasLocked
                            ? 'Nouveau mot de passe appliqué à l’enregistrement.'
                            : 'La note sera verrouillée à l’enregistrement.'}
                    </p>
                )}
                {lockChange && 'remove' in lockChange && (
                    <p className={styles.lockNotice}>
                        <span className={`icon ${styles.toggleIcon} icon-unlock`} />
                        Le verrou sera retiré à l’enregistrement.
                    </p>
                )}

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
                                onClick={() => void requestDelete()}
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
                            className={`${styles.iconToggle} ${lockedAfterSave ? styles.iconToggleActive : ''}`}
                            aria-pressed={lockedAfterSave}
                            title={lockedAfterSave ? 'Gérer le verrou' : 'Verrouiller cette note'}
                            onClick={() => void toggleLock()}
                        >
                            <span className={`icon ${styles.toggleIcon} icon-${lockedAfterSave ? 'lock' : 'unlock'}`} />
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
