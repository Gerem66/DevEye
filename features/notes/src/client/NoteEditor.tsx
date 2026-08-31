import { useRef, useState } from 'react';

import styles from './style.module.css';

import {
    Button,
    ClosePopup,
    DialogCancelButton,
    FeatureSettingsButton,
    openInfo,
    OpenPopup,
    Popup,
    useActiveWorkspace
} from 'deveye-sdk-client';
import BlockEditor from './BlockEditor';
import { exportNotePdf } from './exportPdf';
import { NOTE_CONFIRM_POPUP, type ConfirmInput } from './ConfirmPopup';

import { NOTE_TITLE_MAX_LENGTH, type Note, type NoteBlock } from '../contracts/domain';

export const NOTE_EDITOR_POPUP = 'popup-note-editor';

export interface NoteDraft {
    title: string;
    folderId: number | null;
    blocks: NoteBlock[];
    /** Encrypt with the password-protected key instead of the open one. */
    private: boolean;
}

export type NoteEditorResult = NoteDraft | 'delete' | null;

/**
 * `note` is the note to edit, or null to create. `folderId` files a *new* note
 * into the section whose "+" was clicked; it is ignored when editing.
 */
export interface NoteEditorInput {
    note: Note | null;
    folderId: number | null;
}

function emptyBlocks(): NoteBlock[] {
    return [{ type: 'text', text: '' }];
}

function formatStamp(time: number): string {
    return new Date(time * 1000).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatDate(time: number): string {
    return new Date(time * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function normalizeBlocks(blocks: NoteBlock[]): NoteBlock[] {
    return blocks.filter((b) => b.type === 'divider' || b.text.trim() !== '');
}

function showPrivateInfo() {
    void openInfo({
        title: 'Notes privées',
        body: (
            <>
                <p>
                    Une note ordinaire est chiffrée avec une clé que le serveur sait déballer seul : elle s’ouvre sans
                    aucune saisie. Une note <strong>privée</strong> est chiffrée avec la clé dérivée de votre mot de
                    passe : tant que la session n’est pas déverrouillée, son titre comme son contenu restent illisibles,
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
 * Create and edit share this surface, driven imperatively via OpenPopup. The
 * note's folder and position are set from the main screen, never here.
 */
export default function NoteEditor() {
    // Le drapeau « privée » n'existe que dans l'espace personnel, ce que le
    // serveur revérifie (`assertPrivateAllowed`).
    const isPersonalWorkspace = useActiveWorkspace()?.kind === 'personal';
    const [mode, setMode] = useState<'add' | 'edit'>('add');
    const [title, setTitle] = useState('');
    const [folderId, setFolderId] = useState<number | null>(null);
    const [blocks, setBlocks] = useState<NoteBlock[]>(emptyBlocks);
    const [isPrivate, setIsPrivate] = useState(false);
    const [created, setCreated] = useState<number | null>(null);
    const [updated, setUpdated] = useState<number | null>(null);
    /**
     * La note telle qu'elle est enregistrée, pour ce qui ne dépend pas du
     * brouillon : son identifiant, sa provenance, et si elle est privée en base,
     * ce que le serveur regarde pour accepter de la partager.
     */
    const [stored, setStored] = useState<{ id: number; private: boolean; foreign: boolean } | null>(null);
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
            setStored(null);
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
        setStored({ id: note.id, private: note.private, foreign: note.foreign });
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

    // Past ~10 lines the compact dialog gets cramped: the editor switches to a
    // tall popup whose title and footer stay pinned while only the block list
    // scrolls, and snaps back once the content drops below again.
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
                <>
                    {/* Une note privée est chiffrée par le mot de passe de son
                        auteur, donc jamais projetable : l'onglet Partage ne lui est
                        pas proposé, plutôt qu'ouvert sur un refus. */}
                    {stored && (
                        <FeatureSettingsButton
                            variant='ghost'
                            scope={{
                                kind: 'item',
                                feature: 'notes',
                                itemId: String(stored.id),
                                itemLabel: title.trim() || 'Sans titre',
                                shareable: !stored.private
                            }}
                        />
                    )}
                    <button
                        type='button'
                        className={styles.editorInfoBtn}
                        aria-label='À propos des notes privées'
                        title='Comment fonctionnent les notes privées ?'
                        onClick={showPrivateInfo}
                    >
                        <span className='icon icon-info' />
                    </button>
                </>
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
                            {/* « Privée » est du chiffrement, pas un contrôle d'accès :
                                la clé est celle du propriétaire, donc la note serait
                                illisible pour les autres membres d'un espace partagé, et
                                illisible chez elle si elle vient d'un autre espace. Le
                                serveur refuse les deux, le bouton ne s'affiche pas. */}
                            {isPersonalWorkspace && !stored?.foreign && (
                                <button
                                    type='button'
                                    className={`${styles.iconToggle} ${isPrivate ? styles.iconToggleActive : ''}`}
                                    aria-pressed={isPrivate}
                                    title={
                                        isPrivate ? 'Rendre la note lisible sans mot de passe' : 'Rendre la note privée'
                                    }
                                    onClick={() => setIsPrivate((v) => !v)}
                                >
                                    <span
                                        className={`icon ${styles.toggleIcon} icon-${isPrivate ? 'lock' : 'unlock'}`}
                                    />
                                </button>
                            )}
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
