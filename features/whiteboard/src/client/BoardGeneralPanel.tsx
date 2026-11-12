import {
    Button,
    ConfirmDialog,
    ErrorNote,
    errorNote,
    invalidate,
    openFeature,
    ReadOnlyNotice,
    SaveButton,
    SegmentedControl,
    settingsStyles as shell,
    TextInput,
    useResource,
    useTaskRunner,
    type ConfirmRequest,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import { useEffect, useState } from 'react';

import { WHITEBOARD_TITLE_MAX, type BoardAppearance } from '../contracts/domain';
import { api } from './api';
import { THEME_CHOICES } from './format';
import styles from './style.module.css';
import { displayTitle, duplicationOf } from './Whiteboard';

/** Le fond qu'Excalidraw donne à un tableau qui n'en a pas choisi. */
const DEFAULT_BACKGROUND = '#ffffff';

/** Un sélecteur de couleur ne lit que `#rrggbb` : Excalidraw admet aussi `#rgb` et les noms de couleur. */
function pickerColor(background: string | null): string {
    if (background === null) return DEFAULT_BACKGROUND;
    if (/^#[0-9a-f]{6}$/i.test(background)) return background.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(background))
        return `#${[...background.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
    return DEFAULT_BACKGROUND;
}

type ThemeValue = 'profile' | 'light' | 'dark';
const themeValue = (theme: BoardAppearance['theme']): ThemeValue => theme ?? 'profile';
const themeOf = (value: ThemeValue): BoardAppearance['theme'] => (value === 'profile' ? null : value);

/**
 * Le tableau lui-même : son titre, son thème et son fond, sa copie et sa
 * suppression. Le fond et le thème valent pour tous ses participants, et
 * changent en direct dans l'éditeur ouvert.
 */
export default function BoardGeneralPanel({ scope, canWrite, close, gone }: SettingsPanelProps) {
    const boardId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const list = useResource(
        'whiteboard.list',
        () => api.send('whiteboard.list', {}),
        'Le tableau n’a pas pu être lu.',
        []
    );
    const board = list.data?.boards.find((candidate) => candidate.id === boardId) ?? null;

    const [title, setTitle] = useState('');
    const [theme, setTheme] = useState<ThemeValue>('profile');
    const [background, setBackground] = useState(DEFAULT_BACKGROUND);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const runTask = useTaskRunner();

    // Repris à chaque relecture : un autre participant a pu changer le thème ou le fond.
    const savedTitle = board?.title ?? '';
    const savedTheme = themeValue(board?.theme ?? null);
    const savedBackground = pickerColor(board?.background ?? null);
    useEffect(() => {
        setTitle(savedTitle);
        setTheme(savedTheme);
        setBackground(savedBackground);
    }, [savedTitle, savedTheme, savedBackground]);

    if (board === null) {
        if (list.error !== null) return <ErrorNote note={list.error} />;
        return <p className={shell.empty}>{list.data === null ? 'Chargement…' : 'Ce tableau n’est plus ici.'}</p>;
    }

    const name = displayTitle(board);
    const unchanged = title.trim() === savedTitle.trim() && theme === savedTheme && background === savedBackground;

    const save = async (): Promise<void> => {
        setError(null);
        try {
            if (title.trim() !== savedTitle.trim()) {
                await api.send('whiteboard.rename', { boardId: board.id, title: title.trim() });
            }
            const appearance: Partial<BoardAppearance> = {};
            if (theme !== savedTheme) appearance.theme = themeOf(theme);
            if (background !== savedBackground) appearance.background = background;
            if (Object.keys(appearance).length > 0) {
                await api.send('whiteboard.setAppearance', { boardId: board.id, ...appearance });
            }
            invalidate('whiteboard.list');
        } catch (e) {
            setError(errorNote(e, 'L’enregistrement a échoué.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw e;
        }
    };

    /** La copie s'ouvre aussitôt, comme depuis la grille. */
    const duplicate = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            const { board: copy } = await runTask(duplicationOf(board), (task) =>
                api.send('whiteboard.duplicate', { boardId: board.id }, task.sendOptions)
            );
            invalidate('whiteboard.list', 'whiteboard.count');
            close();
            openFeature('whiteboard', copy.id);
        } catch (e) {
            setError(errorNote(e, 'Le tableau n’a pas pu être dupliqué.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            await api.send('whiteboard.remove', { boardId: board.id });
            // L'éditeur s'en va AVANT que la liste ne se relise : relue après
            // coup, elle chercherait un tableau qui n'existe plus.
            gone();
            invalidate('whiteboard.list', 'whiteboard.count', 'projects.board');
        } catch (e) {
            setError(errorNote(e, 'La suppression a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const editable = canWrite && !busy;
    return (
        <div className={shell.section}>
            <label className={shell.field}>
                <span className={shell.sectionLabel}>Titre</span>
                <TextInput
                    value={title}
                    maxLength={WHITEBOARD_TITLE_MAX}
                    placeholder='Sans titre'
                    disabled={!editable}
                    onChange={(e) => setTitle(e.target.value)}
                />
            </label>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Thème</span>
                <SegmentedControl
                    aria-label='Thème du tableau'
                    value={theme}
                    disabled={!editable}
                    onChange={setTheme}
                    options={THEME_CHOICES.map((choice) => ({ value: themeValue(choice.value), label: choice.label }))}
                />
                <span className={shell.fieldHint}>
                    Commun à tous les participants. « Profil » laisse chacun voir le tableau dans le thème de son
                    profil.
                </span>
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Fond</span>
                <input
                    type='color'
                    className={styles.colorInput}
                    value={background}
                    disabled={!editable}
                    onChange={(e) => setBackground(e.target.value)}
                    aria-label='Couleur du fond'
                />
                <span className={shell.fieldHint}>
                    Commun à tous les participants, comme le fond choisi dans le menu de l’éditeur. En thème sombre,
                    Excalidraw l’assombrit.
                </span>
            </div>

            {canWrite ? (
                <SaveButton onSave={save} disabled={busy || unchanged} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier un tableau : cela relève de l’écriture sur le Tableau blanc.
                </ReadOnlyNotice>
            )}

            {canWrite && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Dupliquer ce tableau</span>
                    <span className={shell.fieldHint}>
                        Une copie dans cet espace, images comprises, qui s’ouvre aussitôt. Le tableau d’origine n’est
                        pas touché.
                    </span>
                    <div className={shell.sectionActions}>
                        <Button variant='secondary' icon='copy' disabled={busy} onClick={() => void duplicate()}>
                            Dupliquer
                        </Button>
                    </div>
                </div>
            )}

            {canWrite &&
                (board.foreign ? (
                    <p className={shell.sectionHint}>
                        Ce tableau vient d’un autre espace, qui le partage ici : il se supprime depuis là-bas.
                    </p>
                ) : (
                    <div className={shell.field}>
                        <span className={shell.sectionLabel}>Supprimer ce tableau</span>
                        <span className={shell.fieldHint}>
                            Le dessin et ses images sont effacés pour tous les membres, et les projets qui le rattachent
                            perdent leur lien.
                        </span>
                        <div className={shell.sectionActions}>
                            <Button
                                variant='danger'
                                disabled={busy}
                                onClick={() =>
                                    setConfirm({
                                        title: `Supprimer « ${name} » ?`,
                                        description:
                                            'Le dessin et ses images sont effacés pour tous les membres. Cette action est définitive.',
                                        confirmLabel: 'Supprimer le tableau',
                                        onConfirm: () => void remove()
                                    })
                                }
                            >
                                Supprimer le tableau
                            </Button>
                        </div>
                    </div>
                ))}

            <ErrorNote note={error} />

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
