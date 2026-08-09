import { useEffect, useState } from 'react';
import type {
    MinimalUser,
    ProjectCard,
    ProjectCardDep,
    ProjectCardDraft,
    ProjectChecklistItem,
    ProjectMilestone,
    ProjectPriority
} from 'deveye-types';
import {
    PROJECT_CARD_TITLE_MAX_LENGTH,
    PROJECT_CHECKLIST_LABEL_MAX_LENGTH,
    PROJECT_MAX_CHECKLIST_ITEMS,
    PROJECT_PRIORITIES
} from 'deveye-types';
import { Button, Dialog, SelectInput, TextInput } from '@/Components';
import { Chat } from '../Chat/Chat';
import { dateInputToSeconds, dateInputValue, PRIORITY_LABELS } from '../api';
import styles from '../style.module.css';

interface CardDialogProps {
    open: boolean;
    /** `null` = création. */
    card: ProjectCard | null;
    members: MinimalUser[];
    /** L'appelant, pour ne pas s'annoncer soi-même « en train d'écrire ». */
    meUserId: number;
    canWrite: boolean;
    /** Les autres cartes vivantes du projet, candidates aux dépendances. */
    siblings: ProjectCard[];
    milestones: ProjectMilestone[];
    /** Les arêtes du projet ; on n'affiche que celles de cette carte. */
    deps: ProjectCardDep[];
    busy: boolean;
    error: string | null;
    onClose: () => void;
    onSubmit: (draft: ProjectCardDraft) => void;
    onArchive?: () => void;
    onDepAdd: (blockedByCardId: number) => void;
    onDepRemove: (blockedByCardId: number) => void;
    onSetMilestone: (milestoneId: number | null) => void;
}

const EMPTY: ProjectCardDraft = {
    title: '',
    description: '',
    checklist: [],
    priority: 'normal',
    assigneeUserId: null,
    startDate: null,
    dueDate: null,
    estimateMinutes: null
};

/** Identifiant local d'une sous-tâche : c'est sa clé de rendu, pas une clé SQL. */
function newItemId(): string {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function CardDialog({
    open,
    card,
    members,
    meUserId,
    canWrite,
    siblings,
    milestones,
    deps,
    busy,
    error,
    onClose,
    onSubmit,
    onArchive,
    onDepAdd,
    onDepRemove,
    onSetMilestone
}: CardDialogProps) {
    const [draft, setDraft] = useState<ProjectCardDraft>(EMPTY);
    const [itemLabel, setItemLabel] = useState('');
    const [depPick, setDepPick] = useState('');
    /** La sous-tâche dont on vient de demander le retrait ; `null` = personne. */
    const [removing, setRemoving] = useState<ProjectChecklistItem | null>(null);
    /**
     * Son libellé, gardé à part : la popup s'efface en fondu, et lire
     * « «  » quittera la liste » pendant sa sortie serait pire que rien.
     */
    const [removingLabel, setRemovingLabel] = useState('');

    /** Les cartes qui bloquent celle-ci. */
    const blockers = card ? deps.filter((d) => d.cardId === card.id) : [];
    /** Celles qu'elle bloque : utile à voir, non modifiable d'ici. */
    const blocking = card ? deps.filter((d) => d.blockedByCardId === card.id) : [];
    const titleOf = (id: number) => siblings.find((c) => c.id === id)?.title || `Tâche #${id}`;
    // On ne propose ni la carte elle-même, ni un bloqueur déjà déclaré. Les
    // cycles plus longs sont refusés par le serveur, qui voit tout le graphe.
    const candidates = card
        ? siblings.filter((c) => c.id !== card.id && !blockers.some((d) => d.blockedByCardId === c.id))
        : [];

    useEffect(() => {
        if (!open) return;
        setDraft(
            card
                ? {
                      title: card.title,
                      description: card.description,
                      checklist: card.checklist,
                      priority: card.priority,
                      assigneeUserId: card.assigneeUserId,
                      startDate: card.startDate,
                      dueDate: card.dueDate,
                      estimateMinutes: card.estimateMinutes
                  }
                : EMPTY
        );
        setItemLabel('');
        setRemoving(null);
    }, [open, card]);

    const patch = (next: Partial<ProjectCardDraft>) => setDraft((d) => ({ ...d, ...next }));

    const addItem = () => {
        const label = itemLabel.trim();
        if (!label || draft.checklist.length >= PROJECT_MAX_CHECKLIST_ITEMS) return;
        patch({ checklist: [...draft.checklist, { id: newItemId(), label, done: false }] });
        setItemLabel('');
    };

    const toggleItem = (id: string) =>
        patch({
            checklist: draft.checklist.map((i: ProjectChecklistItem) => (i.id === id ? { ...i, done: !i.done } : i))
        });

    const askRemove = (item: ProjectChecklistItem) => {
        setRemoving(item);
        setRemovingLabel(item.label);
    };

    /**
     * Retire la sous-tâche confirmée.
     *
     * Le retrait n'est pas rattrapable : la ligne quitte le brouillon, et rien
     * dans ce dialogue ne la ramène — d'où la confirmation qui y mène.
     */
    const removeConfirmed = () => {
        if (!removing) return;
        patch({ checklist: draft.checklist.filter((i: ProjectChecklistItem) => i.id !== removing.id) });
        setRemoving(null);
    };

    const submit = () => {
        if (busy || !draft.title.trim()) return;
        onSubmit({ ...draft, title: draft.title.trim() });
    };

    const doneCount = draft.checklist.filter((i) => i.done).length;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={card ? 'Modifier la tâche' : 'Nouvelle tâche'}
            width={720}
            // `fill` et non `tall` : la popup prend la hauteur de son contenu
            // et s'arrête au bord de l'écran, au lieu d'occuper d'emblée toute
            // la hauteur même pour une tâche de trois champs. C'est la
            // discussion, plus bas, qui absorbe la place restante et devient la
            // seule zone défilante.
            fill={card !== null}
            onSubmit={submit}
            holdSecrecy
            footer={
                <>
                    {/* Une carte ne se supprime pas : l'archivage est la seule sortie. */}
                    {card && onArchive && (
                        <Button variant='danger' icon='archive' onClick={onArchive} disabled={busy}>
                            Archiver
                        </Button>
                    )}
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || !draft.title.trim()}>
                        {busy ? 'Enregistrement…' : card ? 'Enregistrer' : 'Créer'}
                    </Button>
                </>
            }
        >
            <div className={card ? styles.formFill : styles.form}>
                <label className={styles.field}>
                    <span className={styles.label}>Titre</span>
                    <TextInput
                        data-autofocus
                        value={draft.title}
                        maxLength={PROJECT_CARD_TITLE_MAX_LENGTH}
                        placeholder='Ce qu’il y a à faire'
                        onChange={(e) => patch({ title: e.target.value })}
                    />
                </label>

                <label className={styles.field}>
                    <span className={styles.label}>Description</span>
                    <textarea
                        className={styles.textarea}
                        value={draft.description}
                        rows={4}
                        onChange={(e) => patch({ description: e.target.value })}
                    />
                </label>

                <div className={styles.row}>
                    <label className={styles.field}>
                        <span className={styles.label}>Assignée à</span>
                        <SelectInput
                            value={draft.assigneeUserId === null ? '' : String(draft.assigneeUserId)}
                            onChange={(e) => patch({ assigneeUserId: e.target.value ? Number(e.target.value) : null })}
                        >
                            <option value=''>Personne</option>
                            {members.map((m) => (
                                <option key={m.id} value={m.id}>
                                    {m.username}
                                </option>
                            ))}
                        </SelectInput>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.label}>Priorité</span>
                        <SelectInput
                            value={draft.priority}
                            onChange={(e) => patch({ priority: e.target.value as ProjectPriority })}
                        >
                            {PROJECT_PRIORITIES.map((p) => (
                                <option key={p} value={p}>
                                    {PRIORITY_LABELS[p]}
                                </option>
                            ))}
                        </SelectInput>
                    </label>
                </div>

                <div className={styles.row}>
                    <label className={styles.field}>
                        <span className={styles.label}>Début</span>
                        <TextInput
                            type='date'
                            value={dateInputValue(draft.startDate)}
                            onChange={(e) => patch({ startDate: dateInputToSeconds(e.target.value) })}
                        />
                    </label>
                    <label className={styles.field}>
                        <span className={styles.label}>Échéance</span>
                        <TextInput
                            type='date'
                            value={dateInputValue(draft.dueDate)}
                            onChange={(e) => patch({ dueDate: dateInputToSeconds(e.target.value) })}
                        />
                    </label>
                    <label className={styles.field}>
                        <span className={styles.label}>Estimation (min)</span>
                        <TextInput
                            type='number'
                            min={0}
                            value={draft.estimateMinutes === null ? '' : String(draft.estimateMinutes)}
                            onChange={(e) => patch({ estimateMinutes: e.target.value ? Number(e.target.value) : null })}
                        />
                    </label>
                </div>

                {/* Les sous-tâches ont leur encart : c'est une liste qu'on
                    coche, pas un champ de formulaire de plus. */}
                <div className={styles.checkPanel}>
                    <div className={styles.checkHead}>
                        <span className={styles.label}>Sous-tâches</span>
                        {draft.checklist.length > 0 && (
                            <span className={styles.checkCount}>
                                {doneCount}/{draft.checklist.length}
                            </span>
                        )}
                    </div>

                    {draft.checklist.length > 0 && (
                        <ul className={styles.checklist}>
                            {draft.checklist.map((item) => (
                                <li key={item.id} className={styles.checkItem}>
                                    <button
                                        type='button'
                                        className={styles.checkToggle}
                                        onClick={() => toggleItem(item.id)}
                                        aria-pressed={item.done}
                                    >
                                        <span className={`icon icon-${item.done ? 'square-check' : 'square-empty'}`} />
                                    </button>
                                    {/* L'intitulé porte toujours `checkLabel` :
                                        c'est lui qui tient la croix à droite,
                                        cochée ou non. */}
                                    <span
                                        className={
                                            item.done ? `${styles.checkLabel} ${styles.checkDone}` : styles.checkLabel
                                        }
                                    >
                                        {item.label}
                                    </span>
                                    <button
                                        type='button'
                                        className={styles.tagRemove}
                                        aria-label={`Retirer ${item.label}`}
                                        onClick={() => askRemove(item)}
                                    >
                                        <span className='icon icon-x' />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}

                    <div className={styles.checkAdd}>
                        <TextInput
                            value={itemLabel}
                            maxLength={PROJECT_CHECKLIST_LABEL_MAX_LENGTH}
                            placeholder='Ajouter une sous-tâche'
                            onChange={(e) => setItemLabel(e.target.value)}
                        />
                        <Button variant='secondary' onClick={addItem} disabled={!itemLabel.trim()}>
                            Ajouter
                        </Button>
                    </div>
                </div>

                {/* Le retrait se confirme : rien dans ce dialogue ne ramène une
                    sous-tâche effacée. Déclarée ici, contre ce qu'elle protège —
                    un Dialog se rend dans un portail, sa place dans l'arbre n'a
                    donc aucun effet de mise en page, et la pile de fermeture est
                    chronologique : Échap annule le retrait sans refermer la
                    tâche dessous. */}
                <Dialog
                    open={removing !== null}
                    onClose={() => setRemoving(null)}
                    onSubmit={removeConfirmed}
                    title='Retirer la sous-tâche'
                    footer={
                        <>
                            <Button variant='secondary' onClick={() => setRemoving(null)}>
                                Annuler
                            </Button>
                            <Button variant='danger' onClick={removeConfirmed}>
                                Retirer
                            </Button>
                        </>
                    }
                >
                    <p>
                        « {removingLabel} » quittera la liste. Le retrait est définitif à l’enregistrement de la tâche.
                    </p>
                </Dialog>

                {/* Jalon et dépendances n'existent que sur une carte déjà créée :
                    les deux se rattachent à son identifiant. */}
                {card && (
                    <label className={styles.field}>
                        <span className={styles.label}>Jalon</span>
                        <SelectInput
                            value={card.milestoneId === null ? '' : String(card.milestoneId)}
                            disabled={!canWrite}
                            onChange={(e) => onSetMilestone(e.target.value ? Number(e.target.value) : null)}
                        >
                            <option value=''>Aucun</option>
                            {milestones.map((m) => (
                                <option key={m.id} value={m.id}>
                                    {m.name || `Jalon #${m.id}`}
                                </option>
                            ))}
                        </SelectInput>
                    </label>
                )}

                {/*
                 * Les dépendances de la tâche : ce qui doit être terminé avant
                 * qu'elle puisse démarrer.
                 *
                 * Le bloc ne se rend que s'il a quelque chose à montrer **ou**
                 * quelque chose à faire faire. Il s'affichait auparavant dès
                 * qu'une tâche existait : sur un projet d'une seule tâche, on
                 * lisait donc un intitulé « Bloquée par » suivi de rien — un
                 * champ qui n'explique pas ce qu'il attend et n'offre rien à
                 * remplir n'apprend rien à personne.
                 *
                 * L'intitulé porte désormais son explication, et la frise trace
                 * ces liens en flèches (voir `Timeline`). Le serveur refuse les
                 * cycles : A ne peut pas attendre B qui attend A.
                 */}
                {card && (blockers.length > 0 || blocking.length > 0 || (canWrite && candidates.length > 0)) && (
                    <div className={styles.field}>
                        <span className={styles.label}>Dépend de</span>
                        <span className={styles.hint}>
                            Les tâches à terminer avant celle-ci. La frise les relie par une flèche.
                        </span>
                        {blockers.length > 0 && (
                            <ul className={styles.tags}>
                                {blockers.map((d) => (
                                    <li key={d.blockedByCardId} className={styles.tag}>
                                        {titleOf(d.blockedByCardId)}
                                        {canWrite && (
                                            <button
                                                type='button'
                                                className={styles.tagRemove}
                                                aria-label={`Retirer la dépendance ${titleOf(d.blockedByCardId)}`}
                                                onClick={() => onDepRemove(d.blockedByCardId)}
                                            >
                                                <span className='icon icon-x' />
                                            </button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {canWrite && candidates.length > 0 && (
                            <div className={styles.tagRow}>
                                <SelectInput value={depPick} onChange={(e) => setDepPick(e.target.value)}>
                                    <option value=''>Choisir une tâche…</option>
                                    {candidates.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {c.title || `Tâche #${c.id}`}
                                        </option>
                                    ))}
                                </SelectInput>
                                <Button
                                    variant='secondary'
                                    disabled={!depPick}
                                    onClick={() => {
                                        onDepAdd(Number(depPick));
                                        setDepPick('');
                                    }}
                                >
                                    Ajouter
                                </Button>
                            </div>
                        )}
                        {blocking.length > 0 && (
                            <span className={styles.hint}>
                                Cette tâche bloque : {blocking.map((d) => titleOf(d.cardId)).join(', ')}
                            </span>
                        )}
                    </div>
                )}

                {/* Le fil n'existe que sur une carte déjà créée : il lui est
                    rattaché par son identifiant. */}
                {card && (
                    <div className={styles.chatField}>
                        <span className={styles.label}>Discussion</span>
                        <Chat cardId={card.id} members={members} meUserId={meUserId} canWrite={canWrite} />
                    </div>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default CardDialog;
