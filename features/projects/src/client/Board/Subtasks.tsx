import { useRef, useState } from 'react';
import { Button, Checkbox, Dialog, SearchSelect, useDragReorder } from 'deveye-sdk-client';
import type { MinimalUser } from '@deveye/types';
import { formatDate, formatDateTime, relativeAgo } from '../api';
import {
    PROJECT_CHECKLIST_LABEL_MAX_LENGTH,
    PROJECT_MAX_CHECKLIST_ITEMS,
    type ProjectChecklistItem
} from '../../contracts/domain';
import { HIDDEN_MEMBER_LABEL, MemberAvatar, useAssigneeOptions } from '../Member';
import styles from '../style.module.css';

interface SubtasksProps {
    items: ProjectChecklistItem[];
    members: readonly MinimalUser[];
    meUserId: number;
    /** Chaque geste part sur-le-champ : l'appelant persiste la liste entière. */
    onChange: (next: ProjectChecklistItem[]) => void;
    /** Un glissé commence ou finit : l'appelant retient ce qui arriverait d'ailleurs. */
    onDragStateChange: (dragging: boolean) => void;
    /** Le champ d'ajout prend le focus à l'ouverture de la popup. */
    autoFocus: boolean;
}

/** Identifiant local d'une sous-tâche : c'est sa clé de rendu, pas une clé SQL. */
function newItemId(): string {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * La liste de sous-tâches d'une carte. Elle se coche, se range par sa poignée, et
 * chaque ligne se déplie en place pour se retoucher : texte, assigné, et le
 * drapeau qui ferme à la tâche l'entrée d'une colonne terminée.
 */
export function Subtasks({ items, members, meUserId, onChange, onDragStateChange, autoFocus }: SubtasksProps) {
    const [label, setLabel] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [removing, setRemoving] = useState<ProjectChecklistItem | null>(null);
    /** Gardé à part : la popup s'efface en fondu, et y lire un nom vide serait pire que rien. */
    const [removingLabel, setRemovingLabel] = useState('');
    const addRef = useRef<HTMLTextAreaElement>(null);

    const drag = useDragReorder<HTMLUListElement, HTMLLIElement>({
        ids: items.map((i) => i.id),
        rowSelector: '[data-check-row]',
        onDragStateChange,
        onReorder: (ids) => {
            const byId = new Map(items.map((i) => [i.id, i]));
            onChange(ids.flatMap((id) => byId.get(String(id)) ?? []));
        }
    });

    const add = () => {
        const text = label.trim();
        if (!text || items.length >= PROJECT_MAX_CHECKLIST_ITEMS) return;
        onChange([
            ...items,
            {
                id: newItemId(),
                label: text,
                done: false,
                assigneeUserId: null,
                required: false,
                createdAt: null,
                doneAt: null,
                doneBy: null
            }
        ]);
        setLabel('');
        addRef.current?.focus();
    };

    // Les horodatages posés ici ne servent qu'à l'affichage immédiat : le serveur
    // les recalcule et c'est sa version qui revient.
    const toggle = (id: string) => {
        const now = Math.floor(Date.now() / 1000);
        onChange(
            items.map((i) =>
                i.id !== id
                    ? i
                    : i.done
                      ? { ...i, done: false, doneAt: null, doneBy: null }
                      : { ...i, done: true, doneAt: now, doneBy: meUserId }
            )
        );
    };

    const doneCount = items.filter((i) => i.done).length;
    const nameOf = (userId: number) => members.find((m) => m.id === userId)?.username ?? HIDDEN_MEMBER_LABEL;
    const doneSentence = (item: ProjectChecklistItem): string | null => {
        if (item.doneAt === null) return null;
        const by = item.doneBy === null ? '' : ` par ${nameOf(item.doneBy)}`;
        return `Terminée${by} le ${formatDateTime(item.doneAt)}`;
    };

    return (
        <div className={styles.subPage}>
            <div className={styles.checkHead}>
                <span className={styles.label}>Sous-tâches</span>
                {items.length > 0 && (
                    <span className={styles.checkCount}>
                        {doneCount}/{items.length}
                    </span>
                )}
            </div>

            {items.length > 0 && (
                <div className={styles.checkScroll}>
                    <ul ref={drag.listRef} className={styles.checklist}>
                        {items.map((item) => (
                            <li
                                key={item.id}
                                data-check-row=''
                                className={drag.draggingId === item.id ? styles.checkRowDragging : styles.checkRow}
                            >
                                <div className={styles.checkItem}>
                                    <button
                                        type='button'
                                        className={styles.checkGrip}
                                        title='Déplacer cette sous-tâche'
                                        aria-label={`Déplacer ${item.label}`}
                                        onPointerDown={(e) => drag.onGripPointerDown(e, item.id)}
                                    >
                                        <span className='icon icon-drag' />
                                    </button>
                                    <Checkbox
                                        checked={item.done}
                                        onChange={() => toggle(item.id)}
                                        aria-label={item.label}
                                    />
                                    <span
                                        className={
                                            item.done ? `${styles.checkLabel} ${styles.checkDone}` : styles.checkLabel
                                        }
                                    >
                                        {item.label}
                                    </span>
                                    {item.required && (
                                        <span
                                            className={item.done ? styles.checkRequiredMet : styles.checkRequired}
                                            role='img'
                                            title='Obligatoire pour terminer la tâche'
                                            aria-label='Obligatoire pour terminer la tâche'
                                        >
                                            <span className='icon icon-lock' aria-hidden='true' />
                                        </span>
                                    )}
                                    {item.doneAt !== null && (
                                        <span className={styles.checkStamp} title={doneSentence(item) ?? undefined}>
                                            {/* Qui a coché ne se montre que s'il apprend quelque chose :
                                                ni soi, ni l'assigné déjà affiché sur la ligne. */}
                                            {item.doneBy !== null &&
                                                item.doneBy !== meUserId &&
                                                item.doneBy !== item.assigneeUserId && (
                                                    <MemberAvatar userId={item.doneBy} size={16} />
                                                )}
                                            {relativeAgo(item.doneAt)}
                                        </span>
                                    )}
                                    {item.assigneeUserId !== null && (
                                        <MemberAvatar userId={item.assigneeUserId} size={20} />
                                    )}
                                    <button
                                        type='button'
                                        className={styles.tagRemove}
                                        aria-label={`Modifier ${item.label}`}
                                        aria-expanded={editingId === item.id}
                                        onClick={() => setEditingId(editingId === item.id ? null : item.id)}
                                    >
                                        <span className='icon icon-edit' />
                                    </button>
                                    <button
                                        type='button'
                                        className={styles.tagRemove}
                                        aria-label={`Retirer ${item.label}`}
                                        onClick={() => {
                                            setRemoving(item);
                                            setRemovingLabel(item.label);
                                        }}
                                    >
                                        <span className='icon icon-x' />
                                    </button>
                                </div>

                                {editingId === item.id && (
                                    <SubtaskEditor
                                        item={item}
                                        members={members}
                                        footer={[
                                            item.createdAt !== null ? `Créée le ${formatDate(item.createdAt)}` : null,
                                            doneSentence(item)
                                        ]
                                            .filter(Boolean)
                                            .join(' · ')}
                                        onCancel={() => setEditingId(null)}
                                        onSave={(next) => {
                                            onChange(items.map((i) => (i.id === next.id ? next : i)));
                                            setEditingId(null);
                                        }}
                                    />
                                )}
                            </li>
                        ))}
                        <li ref={drag.barRef} className={styles.checkDropBar} aria-hidden='true' />
                    </ul>
                </div>
            )}

            <div className={styles.checkAdd}>
                <div className={styles.grow} data-value={label}>
                    <textarea
                        ref={addRef}
                        className={styles.textarea}
                        data-autofocus={autoFocus ? '' : undefined}
                        value={label}
                        rows={1}
                        maxLength={PROJECT_CHECKLIST_LABEL_MAX_LENGTH}
                        placeholder='Ajouter une sous-tâche'
                        aria-label='Ajouter une sous-tâche'
                        onChange={(e) => setLabel(e.target.value)}
                        onKeyDown={(e) => {
                            // Entrée ajoute, Maj+Entrée passe à la ligne : le Dialog
                            // ignore les textarea, la popup ne se valide pas.
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                add();
                            }
                        }}
                    />
                </div>
                <Button variant='secondary' onClick={add} disabled={!label.trim()}>
                    Ajouter
                </Button>
            </div>

            {/* Déclaré ici, contre ce qu'il protège : un Dialog se rend dans un
                portail, et la pile de fermeture étant chronologique, Échap annule
                le retrait sans refermer la tâche dessous. */}
            <Dialog
                open={removing !== null}
                onClose={() => setRemoving(null)}
                onSubmit={() => {
                    if (removing) onChange(items.filter((i) => i.id !== removing.id));
                    setRemoving(null);
                }}
                title='Retirer la sous-tâche'
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setRemoving(null)}>
                            Annuler
                        </Button>
                        <Button
                            variant='danger'
                            onClick={() => {
                                if (removing) onChange(items.filter((i) => i.id !== removing.id));
                                setRemoving(null);
                            }}
                        >
                            Retirer
                        </Button>
                    </>
                }
            >
                <p>« {removingLabel} » quittera la liste, sans retour possible.</p>
            </Dialog>
        </div>
    );
}

interface SubtaskEditorProps {
    item: ProjectChecklistItem;
    members: readonly MinimalUser[];
    /** Les dates de la sous-tâche, en une ligne ; vide quand il n'y a rien à en dire. */
    footer: string;
    onCancel: () => void;
    onSave: (next: ProjectChecklistItem) => void;
}

function SubtaskEditor({ item, members, footer, onCancel, onSave }: SubtaskEditorProps) {
    const [label, setLabel] = useState(item.label);
    const [assigneeUserId, setAssigneeUserId] = useState(item.assigneeUserId);
    const [required, setRequired] = useState(item.required);
    const options = useAssigneeOptions(members, assigneeUserId);

    const save = () => {
        const text = label.trim();
        if (text) onSave({ ...item, label: text, assigneeUserId, required });
    };

    return (
        <div className={styles.checkEdit}>
            <div className={styles.grow} data-value={label}>
                <textarea
                    className={styles.textarea}
                    autoFocus
                    value={label}
                    rows={1}
                    maxLength={PROJECT_CHECKLIST_LABEL_MAX_LENGTH}
                    aria-label='Texte de la sous-tâche'
                    onChange={(e) => setLabel(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            save();
                        }
                    }}
                />
            </div>
            <div className={styles.checkEditRow}>
                <div className={styles.checkEditAssignee}>
                    <SearchSelect
                        aria-label='Sous-tâche assignée à'
                        value={assigneeUserId === null ? '' : String(assigneeUserId)}
                        options={options}
                        onChange={(v) => setAssigneeUserId(v ? Number(v) : null)}
                    />
                </div>
                <Checkbox checked={required} onChange={setRequired}>
                    Obligatoire pour terminer la tâche
                </Checkbox>
            </div>
            <div className={styles.checkEditRow}>
                {footer && <span className={styles.checkEditFooter}>{footer}</span>}
                <span className={styles.card2Spacer} />
                <Button variant='secondary' onClick={onCancel}>
                    Annuler
                </Button>
                <Button onClick={save} disabled={!label.trim()}>
                    Enregistrer
                </Button>
            </div>
        </div>
    );
}
