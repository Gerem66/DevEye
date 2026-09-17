import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Button, Dialog, SelectInput, TextInput, useLiveOutlines, useLiveSegment } from 'deveye-sdk-client';
import type { MinimalUser } from '@deveye/types';
import { dateInputToSeconds, dateInputValue, PRIORITY_LABELS } from '../api';
import {
    PROJECT_CARD_TITLE_MAX_LENGTH,
    PROJECT_CHECKLIST_LABEL_MAX_LENGTH,
    PROJECT_MAX_CHECKLIST_ITEMS,
    PROJECT_PRIORITIES,
    type ProjectCard,
    type ProjectCardDep,
    type ProjectCardDraft,
    type ProjectChecklistItem,
    type ProjectMilestone,
    type ProjectPriority
} from '../../contracts/domain';
import { Chat } from '../Chat/Chat';
import { HIDDEN_MEMBER_LABEL } from '../Member';
import styles from '../style.module.css';

interface CardDialogProps {
    open: boolean;
    /** `null` = création. */
    card: ProjectCard | null;
    members: readonly MinimalUser[];
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
    /**
     * Le brouillon et ses rattachements. Ni le jalon ni les dépendances ne tiennent
     * dans le brouillon chiffré : ce sont des commandes à part, qui exigent une
     * carte déjà née, et rien ne part avant « Enregistrer ».
     */
    onSubmit: (draft: ProjectCardDraft, links: { milestoneId: number | null; blockedBy: number[] }) => void;
    /**
     * La liste de sous-tâches d'une carte existante, qui ne suit pas le sort du
     * reste du formulaire : on la coche depuis l'onglet « Suivi », qui n'a pas de
     * bouton pour l'enregistrer, donc chaque geste part sur-le-champ.
     */
    onChecklistChange: (checklist: ProjectChecklistItem[]) => void;
    onArchive?: () => void;
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

/**
 * `work` : le fil et les sous-tâches. `settings` : la description et les réglages.
 * Une création n'a pas de fil à suivre, elle reste sur `settings`.
 */
type CardTab = 'work' | 'settings';

/**
 * Le brouillon s'écarte-t-il de la carte enregistrée ? La liste de sous-tâches n'y
 * figure pas : elle part à chaque geste, rien d'elle n'est jamais en attente.
 */
function isChanged(draft: ProjectCardDraft, card: ProjectCard | null): boolean {
    if (!card) return false;
    return (
        draft.title !== card.title ||
        draft.description !== card.description ||
        draft.priority !== card.priority ||
        draft.assigneeUserId !== card.assigneeUserId ||
        draft.startDate !== card.startDate ||
        draft.dueDate !== card.dueDate ||
        draft.estimateMinutes !== card.estimateMinutes
    );
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
    onChecklistChange,
    onArchive
}: CardDialogProps) {
    const [draft, setDraft] = useState<ProjectCardDraft>(EMPTY);
    const [openTab, setOpenTab] = useState<CardTab>('work');
    /**
     * L'onglet ouvert. Une création n'en a pas : elle est toujours sur `settings`,
     * et le tenir du rendu et non d'un effet est ce qui met le champ Titre dans le
     * DOM avant que le Dialog ne cherche son `data-autofocus`.
     */
    const tab: CardTab = card ? openTab : 'settings';
    const setTab = setOpenTab;
    const [itemLabel, setItemLabel] = useState('');
    /** Le jalon choisi, hors du brouillon (voir `onSubmit`). */
    const [milestoneId, setMilestoneId] = useState<number | null>(null);
    /** Les tâches déclarées bloquantes. Idem : posées à l'enregistrement. */
    const [blockerIds, setBlockerIds] = useState<number[]>([]);
    /** La sous-tâche dont on vient de demander le retrait ; `null` = personne. */
    const [removing, setRemoving] = useState<ProjectChecklistItem | null>(null);
    /**
     * Son libellé, gardé à part : la popup s'efface en fondu, et lire une phrase
     * au nom vide pendant sa sortie serait pire que rien.
     */
    const [removingLabel, setRemovingLabel] = useState('');

    /** Les bloqueurs tels que le serveur les connaît, avant nos retouches. */
    const savedBlockerIds = card ? deps.filter((d) => d.cardId === card.id).map((d) => d.blockedByCardId) : [];
    /** Celles qu'elle bloque : utile à voir, non modifiable d'ici. */
    const blocking = card ? deps.filter((d) => d.blockedByCardId === card.id) : [];
    const titleOf = (id: number) => siblings.find((c) => c.id === id)?.title || `Tâche #${id}`;
    // On ne propose ni la carte elle-même, ni un bloqueur déjà déclaré. Les
    // cycles plus longs sont refusés par le serveur, qui voit tout le graphe.
    const candidates = siblings.filter((c) => c.id !== card?.id && !blockerIds.includes(c.id));

    /**
     * Remet la popup à l'état de la carte ouverte. Déclenchée sur l'identifiant et
     * non sur l'objet : choisir un jalon remplace la carte détenue par l'appelant,
     * et rejouer la remise à zéro renverrait le brouillon à sa valeur enregistrée
     * en plein milieu d'une saisie.
     */
    const cardId = card?.id ?? null;
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
        setMilestoneId(card?.milestoneId ?? null);
        setBlockerIds(savedBlockerIds);
        // On rouvre une tâche pour son fil, on ouvre une création pour la
        // remplir : chacune s'ouvre là où il y a quelque chose à faire.
        setTab(card ? 'work' : 'settings');
    }, [open, cardId]);

    /**
     * Le dernier niveau de présence, l'onglet ouvert dans cette popup. Déclaré
     * seulement quand la popup l'est et qu'elle porte une carte : le composant
     * reste monté en permanence, et une création n'est pas un lieu qu'on partage.
     */
    const tabTarget = useLiveSegment('l4', open && card ? `tab:${tab}` : null);
    const outlineForTab = useLiveOutlines('l4');

    useEffect(() => {
        if (!tabTarget?.value) return;
        const wanted = tabTarget.value.replace(/^tab:/, '');
        if (wanted === 'work' || wanted === 'settings') setTab(wanted);
    }, [tabTarget]);

    const patch = (next: Partial<ProjectCardDraft>) => setDraft((d) => ({ ...d, ...next }));

    /**
     * Seule la liste de sous-tâches suit la carte quand elle bouge ailleurs : les
     * autres champs attendent « Enregistrer » et les rafraîchir effacerait une
     * saisie. La comparaison évite le rendu inutile, et surtout le retour en
     * arrière de notre propre coche pendant l'aller-retour.
     */
    const savedChecklist = card?.checklist ?? null;
    const savedKey = savedChecklist === null ? null : JSON.stringify(savedChecklist);
    useEffect(() => {
        if (savedChecklist === null) return;
        setDraft((d) => (JSON.stringify(d.checklist) === savedKey ? d : { ...d, checklist: savedChecklist }));
        // `savedKey` seul : il change exactement quand la liste change, là où
        // l'objet, lui, est neuf à chaque re-sollicitation.
    }, [savedKey]);

    /**
     * Le brouillon local est mis à jour dans tous les cas, c'est lui qu'on affiche.
     * À la création, il n'y a personne à qui envoyer : la liste part avec le reste
     * du formulaire.
     */
    const commitChecklist = (next: ProjectChecklistItem[]) => {
        patch({ checklist: next });
        if (card) onChecklistChange(next);
    };

    const addItem = () => {
        const label = itemLabel.trim();
        if (!label || draft.checklist.length >= PROJECT_MAX_CHECKLIST_ITEMS) return;
        commitChecklist([...draft.checklist, { id: newItemId(), label, done: false }]);
        setItemLabel('');
    };

    const toggleItem = (id: string) =>
        commitChecklist(draft.checklist.map((i) => (i.id === id ? { ...i, done: !i.done } : i)));

    const askRemove = (item: ProjectChecklistItem) => {
        setRemoving(item);
        setRemovingLabel(item.label);
    };

    /** Le retrait n'est pas rattrapable, d'où la confirmation qui y mène. */
    const removeConfirmed = () => {
        if (!removing) return;
        commitChecklist(draft.checklist.filter((i) => i.id !== removing.id));
        setRemoving(null);
    };

    const submit = () => {
        if (busy || !draft.title.trim()) return;
        onSubmit({ ...draft, title: draft.title.trim() }, { milestoneId, blockedBy: blockerIds });
    };

    const doneCount = draft.checklist.filter((i) => i.done).length;
    /**
     * Ce qui reste à enregistrer, jalon et dépendances compris : c'est ce drapeau
     * que le Dialog consulte pour retenir une fermeture.
     */
    const changed =
        isChanged(draft, card) ||
        (card !== null &&
            (milestoneId !== card.milestoneId ||
                blockerIds.length !== savedBlockerIds.length ||
                blockerIds.some((id) => !savedBlockerIds.includes(id))));

    /**
     * La hauteur du contenu de l'onglet, mesurée et non calculée : les deux onglets
     * n'ont pas la même mise en page, et l'un contient une discussion dont la
     * taille dépend du fil.
     */
    const panelRef = useRef<HTMLDivElement>(null);
    const [panelHeight, setPanelHeight] = useState<number | null>(null);
    useLayoutEffect(() => {
        const el = panelRef.current;
        if (!el) return;
        const ro = new ResizeObserver(([entry]) => setPanelHeight(entry.contentRect.height));
        ro.observe(el);
        return () => ro.disconnect();
    }, [open]);

    const settings = (
        <>
            <div className={styles.row}>
                <label className={styles.field}>
                    <span className={styles.label}>Jalon</span>
                    <SelectInput
                        value={milestoneId === null ? '' : String(milestoneId)}
                        disabled={!canWrite}
                        onChange={(e) => setMilestoneId(e.target.value ? Number(e.target.value) : null)}
                    >
                        <option value=''>Aucun</option>
                        {milestones.map((m) => (
                            <option key={m.id} value={m.id}>
                                {m.name || `Jalon #${m.id}`}
                            </option>
                        ))}
                    </SelectInput>
                </label>

                {/* Ce qui doit être terminé avant que la tâche puisse démarrer. Le
                    bloc ne se rend que s'il a quelque chose à montrer ou à faire
                    faire ; le serveur refuse les cycles. */}
                {(blockerIds.length > 0 || blocking.length > 0 || (canWrite && candidates.length > 0)) && (
                    <div className={styles.field}>
                        <span className={styles.label}>Dépend de</span>
                        {blockerIds.length > 0 && (
                            <ul className={styles.tags}>
                                {blockerIds.map((id) => (
                                    <li key={id} className={styles.tag}>
                                        {titleOf(id)}
                                        {canWrite && (
                                            <button
                                                type='button'
                                                className={styles.tagRemove}
                                                aria-label={`Retirer la dépendance ${titleOf(id)}`}
                                                onClick={() => setBlockerIds((prev) => prev.filter((x) => x !== id))}
                                            >
                                                <span className='icon icon-x' />
                                            </button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {/* Choisir une tâche l'ajoute : le choix est l'intention.
                            Le sélecteur revient aussitôt sur son intitulé. */}
                        {canWrite && candidates.length > 0 && (
                            <SelectInput
                                value=''
                                onChange={(e) =>
                                    e.target.value && setBlockerIds((prev) => [...prev, Number(e.target.value)])
                                }
                            >
                                <option value=''>Choisir une tâche…</option>
                                {candidates.map((c) => (
                                    <option key={c.id} value={c.id}>
                                        {c.title || `Tâche #${c.id}`}
                                    </option>
                                ))}
                            </SelectInput>
                        )}
                        {blocking.length > 0 && (
                            <span className={styles.hint}>
                                Cette tâche bloque : {blocking.map((d) => titleOf(d.cardId)).join(', ')}
                            </span>
                        )}
                    </div>
                )}
            </div>

            <div className={styles.row}>
                <label className={styles.field}>
                    <span className={styles.label}>Assignée à</span>
                    <SelectInput
                        value={draft.assigneeUserId === null ? '' : String(draft.assigneeUserId)}
                        onChange={(e) => patch({ assigneeUserId: e.target.value ? Number(e.target.value) : null })}
                    >
                        <option value=''>Personne</option>
                        {/* Seuls les membres d'ici se proposent ; l'assigné courant
                            peut n'en être pas (projet projeté), on nomme alors la
                            valeur sans l'offrir. */}
                        {draft.assigneeUserId !== null && !members.some((m) => m.id === draft.assigneeUserId) && (
                            <option value={draft.assigneeUserId} disabled>
                                {HIDDEN_MEMBER_LABEL}
                            </option>
                        )}
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
        </>
    );

    /* Centré à la création, en colonne contre la discussion sur une tâche
       existante. */
    const subtasks = (
        <div className={card ? styles.checkPanelSide : styles.checkPanel}>
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
                            {/* L'intitulé porte toujours `checkLabel` : c'est lui
                                qui tient la croix à droite, cochée ou non. */}
                            <span
                                className={item.done ? `${styles.checkLabel} ${styles.checkDone}` : styles.checkLabel}
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

            {/* Déclaré ici, contre ce qu'il protège : un Dialog se rend dans un
                portail, sa place dans l'arbre n'a aucun effet de mise en page, et
                la pile de fermeture étant chronologique, Échap annule le retrait
                sans refermer la tâche dessous. */}
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
                <p>« {removingLabel} » quittera la liste. Le retrait est définitif à l’enregistrement de la tâche.</p>
            </Dialog>
        </div>
    );

    return (
        <Dialog
            open={open}
            onClose={onClose}
            // Sur « Suivi », l'en-tête porte le titre de la tâche ; sur
            // « Modifier », l'intitulé de ce qu'on y fait.
            title={card ? (tab === 'work' ? draft.title || 'Sans titre' : 'Modifier la tâche') : 'Nouvelle tâche'}
            // Plus large en édition : la discussion et les sous-tâches y partagent
            // une ligne, deux colonnes de 350 px ne se liraient ni l'une ni l'autre.
            width={card ? 980 : 720}
            onSubmit={submit}
            holdSecrecy
            // « Enregistrer » n'est que sur l'onglet des réglages : la garde du
            // Dialog rattrape le cas et propose de conserver ce qui attend.
            dirty={card !== null && changed}
            onSave={submit}
            footer={
                // Uniquement sur l'onglet des réglages : sur « Suivi » on lit un
                // fil et on coche des cases, un formulaire n'y correspond à rien.
                tab === 'settings' ? (
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
                ) : undefined
            }
        >
            <div className={styles.form}>
                {card && (
                    <nav className={styles.tabs}>
                        <button
                            type='button'
                            className={tab === 'work' ? styles.tabActive : styles.tab}
                            aria-current={tab === 'work' ? 'page' : undefined}
                            onClick={() => setTab('work')}
                            {...outlineForTab('tab:work')}
                        >
                            <span className='icon icon-notes' /> Suivi
                        </button>
                        <button
                            type='button'
                            className={tab === 'settings' ? styles.tabActive : styles.tab}
                            aria-current={tab === 'settings' ? 'page' : undefined}
                            onClick={() => setTab('settings')}
                            {...outlineForTab('tab:settings')}
                        >
                            <span className='icon icon-edit' /> Modifier
                        </button>
                    </nav>
                )}

                {/* La hauteur suit le contenu de l'onglet en glissant, plutôt que
                    d'un coup sec. */}
                <motion.div
                    className={styles.tabPanel}
                    initial={false}
                    animate={{ height: panelHeight ?? 'auto' }}
                    transition={{ type: 'spring', stiffness: 340, damping: 34, mass: 0.8 }}
                >
                    <div ref={panelRef} className={styles.tabPanelInner}>
                        {tab === 'settings' && (
                            <>
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
                                {settings}
                            </>
                        )}

                        {/* Masqué et non démonté en passant sur « Modifier » : le
                            fil garde ses messages et son abonnement, là où un
                            remontage rejouerait un « Chargement… » au retour. */}
                        {card && (
                            <div
                                className={tab === 'work' ? styles.workRow : styles.tabHidden}
                                aria-hidden={tab === 'work' ? undefined : true}
                            >
                                <Chat cardId={card.id} members={members} meUserId={meUserId} canWrite={canWrite} />
                                {subtasks}
                            </div>
                        )}

                        {!card && subtasks}

                        {error && <p className={styles.error}>{error}</p>}
                    </div>
                </motion.div>
            </div>
        </Dialog>
    );
}

export default CardDialog;
