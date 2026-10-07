import { useEffect, useMemo, useRef, useState } from 'react';
import {
    Button,
    CountBadge,
    Dialog,
    NumberInput,
    SearchSelect,
    TextInput,
    useLiveOutlines,
    useLiveSegment,
    type SearchSelectOption
} from 'deveye-sdk-client';
import type { MinimalUser } from '@deveye/types';
import { compareFr, dateInputToSeconds, dateInputValue, PRIORITY_LABELS } from '../api';
import { missingPermission, NO_WRITE } from '../rights';
import {
    PROJECT_CARD_TITLE_MAX_LENGTH,
    PROJECT_PRIORITIES,
    type ProjectCard,
    type ProjectCardDep,
    type ProjectCardDraft,
    type ProjectChecklistItem,
    type ProjectMilestone,
    type ProjectPriority
} from '../../contracts/domain';
import { Chat } from '../Chat/Chat';
import { useAssigneeOptions } from '../Member';
import { MilestoneDot } from '../Milestone';
import { Subtasks } from './Subtasks';
import styles from '../style.module.css';

/** `settings` : la tâche et ses réglages. `work` : ses sous-tâches. `chat` : son fil. */
export type CardTab = 'settings' | 'work' | 'chat';

const CARD_TABS: readonly CardTab[] = ['settings', 'work', 'chat'];

const PRIORITY_OPTIONS: readonly SearchSelectOption<ProjectPriority>[] = PROJECT_PRIORITIES.map((p) => ({
    value: p,
    label: PRIORITY_LABELS[p]
}));

interface CardDialogProps {
    open: boolean;
    /** `null` = création. */
    card: ProjectCard | null;
    /** L'onglet demandé à l'ouverture ; sans lui, le fil s'il a du non-lu, le suivi sinon. */
    focus?: CardTab;
    /** Les dates d'une tâche créée depuis la frise. Sans objet à l'ouverture d'une carte. */
    dates?: { startDate: number; dueDate: number };
    members: readonly MinimalUser[];
    /** L'appelant, pour ne pas s'annoncer soi-même « en train d'écrire ». */
    meUserId: number;
    canWrite: boolean;
    /** Poser les dates et le jalon de cette carte : le droit de planifier, ou la carte est sienne. */
    canDate: boolean;
    /** La colonne de la carte vaut « terminé » : ses sous-tâches obligatoires ne se rouvrent pas. */
    columnDone: boolean;
    /** Tenir les jalons et les dépendances du projet. */
    canPlan: boolean;
    /** Écrire dans le fil de la carte. */
    canChat: boolean;
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
     * reste du formulaire : l'onglet « Suivi » n'a pas de bouton pour
     * l'enregistrer, donc chaque geste part sur-le-champ.
     */
    onChecklistChange: (checklist: ProjectChecklistItem[]) => void;
    /** Le fil vient d'être lu : à l'appelant d'éteindre le badge de la carte. */
    onRead: () => void;
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
    focus,
    dates,
    members,
    meUserId,
    canWrite,
    canDate,
    columnDone,
    canPlan,
    canChat,
    siblings,
    milestones,
    deps,
    busy,
    error,
    onClose,
    onSubmit,
    onChecklistChange,
    onRead,
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
    /** Le jalon choisi, hors du brouillon (voir `onSubmit`). */
    const [milestoneId, setMilestoneId] = useState<number | null>(null);
    /** Les tâches déclarées bloquantes. Idem : posées à l'enregistrement. */
    const [blockerIds, setBlockerIds] = useState<number[]>([]);

    /** Les bloqueurs tels que le serveur les connaît, avant nos retouches. */
    const savedBlockerIds = card ? deps.filter((d) => d.cardId === card.id).map((d) => d.blockedByCardId) : [];
    /** Celles qu'elle bloque : utile à voir, non modifiable d'ici. */
    const blocking = card ? deps.filter((d) => d.blockedByCardId === card.id) : [];
    const titleOf = (id: number) => siblings.find((c) => c.id === id)?.title || `Tâche #${id}`;
    // On ne propose ni la carte elle-même, ni un bloqueur déjà déclaré. Les
    // cycles plus longs sont refusés par le serveur, qui voit tout le graphe.
    const candidates = useMemo(
        () =>
            siblings
                .filter((c) => c.id !== card?.id && !blockerIds.includes(c.id))
                .map((c) => ({ value: String(c.id), label: c.title || `Tâche #${c.id}` }))
                .sort((a, b) => compareFr(a.label, b.label)),
        [siblings, card?.id, blockerIds]
    );
    const assigneeOptions = useAssigneeOptions(members, draft.assigneeUserId);

    /**
     * Remet la popup à l'état de la carte ouverte. Déclenchée sur l'identifiant et
     * non sur l'objet : choisir un jalon remplace la carte détenue par l'appelant,
     * et rejouer la remise à zéro renverrait le brouillon à sa valeur enregistrée
     * en plein milieu d'une saisie. `focus` n'y est pas non plus : l'onglet demandé
     * s'impose à l'ouverture, jamais après.
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
                : { ...EMPTY, ...dates }
        );
        setMilestoneId(card?.milestoneId ?? null);
        setBlockerIds(savedBlockerIds);
        // Sans demande, une tâche s'ouvre là où quelque chose attend : son fil
        // s'il a du non-lu, son suivi sinon.
        setTab(card ? (focus ?? (card.unread > 0 ? 'chat' : 'work')) : 'settings');
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
        const wanted = tabTarget.value.replace(/^tab:/, '') as CardTab;
        if (CARD_TABS.includes(wanted)) setTab(wanted);
    }, [tabTarget]);

    const patch = (next: Partial<ProjectCardDraft>) => setDraft((d) => ({ ...d, ...next }));

    /**
     * Seule la liste de sous-tâches suit la carte quand elle bouge ailleurs : les
     * autres champs attendent « Enregistrer » et les rafraîchir effacerait une
     * saisie. La comparaison évite le rendu inutile, et surtout le retour en
     * arrière de notre propre coche pendant l'aller-retour. Pendant un glissé, ce
     * qui arrive attend le relâchement : la liste ne bouge pas sous le pointeur.
     */
    const savedChecklist = card?.checklist ?? null;
    const savedKey = savedChecklist === null ? null : JSON.stringify(savedChecklist);
    const dragging = useRef(false);
    const pending = useRef<ProjectChecklistItem[] | null>(null);
    const adopt = (list: ProjectChecklistItem[]) =>
        setDraft((d) => (JSON.stringify(d.checklist) === JSON.stringify(list) ? d : { ...d, checklist: list }));
    useEffect(() => {
        if (savedChecklist === null) return;
        if (dragging.current) pending.current = savedChecklist;
        else adopt(savedChecklist);
        // `savedKey` seul : il change exactement quand la liste change, là où
        // l'objet, lui, est neuf à chaque re-sollicitation.
    }, [savedKey]);

    /**
     * Le brouillon local est mis à jour dans tous les cas, c'est lui qu'on affiche.
     * À la création, il n'y a personne à qui envoyer : la liste part avec le reste
     * du formulaire.
     */
    const commitChecklist = (next: ProjectChecklistItem[]) => {
        // Notre dépôt l'emporte sur ce qui attendait : il part de la liste affichée.
        pending.current = null;
        patch({ checklist: next });
        if (card) onChecklistChange(next);
    };

    const onSubtaskDrag = (active: boolean) => {
        dragging.current = active;
        if (active || pending.current === null) return;
        adopt(pending.current);
        pending.current = null;
    };

    const submit = () => {
        if (busy || !draft.title.trim()) return;
        onSubmit({ ...draft, title: draft.title.trim() }, { milestoneId, blockedBy: blockerIds });
    };

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

    const settings = (
        <>
            <div className={styles.row}>
                <label className={styles.field}>
                    <span className={styles.label}>Jalon</span>
                    {/* `SearchSelect` et non le déroulant natif : c'est ce qui
                        permet la pastille de couleur devant chaque jalon. */}
                    <SearchSelect
                        aria-label='Jalon de la tâche'
                        value={milestoneId === null ? '' : String(milestoneId)}
                        disabled={!canPlan}
                        options={[
                            { value: '', label: 'Aucun', prefix: <MilestoneDot color={null} /> },
                            ...milestones.map((m) => ({
                                value: String(m.id),
                                label: m.name || `Jalon #${m.id}`,
                                prefix: <MilestoneDot color={m.color} />
                            }))
                        ]}
                        onChange={(v) => setMilestoneId(v ? Number(v) : null)}
                    />
                </label>

                {/* Ce qui doit être terminé avant que la tâche puisse démarrer. Le
                    bloc ne se rend que s'il a quelque chose à montrer ou à faire
                    faire ; le serveur refuse les cycles. */}
                {(blockerIds.length > 0 || blocking.length > 0 || (canPlan && candidates.length > 0)) && (
                    <div className={styles.field}>
                        <span className={styles.label}>Dépend de</span>
                        {blockerIds.length > 0 && (
                            <ul className={styles.tags}>
                                {blockerIds.map((id) => (
                                    <li key={id} className={styles.tag}>
                                        {titleOf(id)}
                                        {canPlan && (
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
                            Aucune option ne porte la valeur vide, le sélecteur
                            revient donc aussitôt sur son intitulé. */}
                        {canPlan && candidates.length > 0 && (
                            <SearchSelect
                                aria-label='Ajouter une dépendance'
                                placeholder='Choisir une tâche…'
                                value=''
                                options={candidates}
                                onChange={(v) => v && setBlockerIds((prev) => [...prev, Number(v)])}
                            />
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
                <div className={styles.field}>
                    <span className={styles.label}>Assignée à</span>
                    <SearchSelect
                        aria-label='Assignée à'
                        value={draft.assigneeUserId === null ? '' : String(draft.assigneeUserId)}
                        options={assigneeOptions}
                        onChange={(v) => patch({ assigneeUserId: v ? Number(v) : null })}
                    />
                </div>
                <label className={styles.field}>
                    <span className={styles.label}>Priorité</span>
                    <SearchSelect
                        value={draft.priority}
                        options={PRIORITY_OPTIONS}
                        onChange={(priority) => patch({ priority })}
                        aria-label='Priorité'
                    />
                </label>
            </div>

            <div className={styles.row}>
                <label className={styles.field}>
                    <span className={styles.label}>Début</span>
                    <TextInput
                        type='date'
                        value={dateInputValue(draft.startDate)}
                        disabled={!canDate}
                        title={canDate ? undefined : missingPermission('plan')}
                        onChange={(e) => patch({ startDate: dateInputToSeconds(e.target.value) })}
                        onClear={() => patch({ startDate: null })}
                    />
                </label>
                <label className={styles.field}>
                    <span className={styles.label}>Échéance</span>
                    <TextInput
                        type='date'
                        value={dateInputValue(draft.dueDate)}
                        disabled={!canDate}
                        title={canDate ? undefined : missingPermission('plan')}
                        onChange={(e) => patch({ dueDate: dateInputToSeconds(e.target.value) })}
                        onClear={() => patch({ dueDate: null })}
                    />
                </label>
                {/* Un `div` et non un `label` : englobé par un label, le champ
                    verrait un clic sur l'intitulé activer son bouton « − ». */}
                <div className={styles.field}>
                    <span className={styles.label}>Estimation (min)</span>
                    <NumberInput
                        aria-label='Estimation en minutes'
                        min={0}
                        value={draft.estimateMinutes}
                        onChange={(v) => patch({ estimateMinutes: v })}
                    />
                </div>
            </div>
        </>
    );

    const subtasks = (
        <Subtasks
            items={draft.checklist}
            members={members}
            meUserId={meUserId}
            onChange={commitChecklist}
            onDragStateChange={onSubtaskDrag}
            autoFocus={tab === 'work'}
            columnDone={columnDone}
        />
    );

    const tabButton = (id: CardTab, icon: string, label: string, badge = 0) => (
        <button
            type='button'
            className={tab === id ? styles.tabActive : styles.tab}
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => setTab(id)}
            {...outlineForTab(`tab:${id}`)}
        >
            <span className={`icon icon-${icon} ${badge > 0 ? styles.chipIconHot : ''}`} /> {label}
            {badge > 0 && <CountBadge count={badge} aria-label={`${badge} non lu${badge > 1 ? 's' : ''}`} />}
        </button>
    );

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={card ? draft.title || 'Sans titre' : 'Nouvelle tâche'}
            width={card ? 980 : 720}
            onSubmit={submit}
            holdSecrecy
            // « Enregistrer » n'est que sur l'onglet des réglages : la garde du
            // Dialog rattrape le cas et propose de conserver ce qui attend.
            dirty={card !== null && changed}
            onSave={submit}
            footer={
                // Uniquement sur l'onglet des réglages : ailleurs on coche des cases
                // et on lit un fil, un formulaire n'y correspond à rien.
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
                        <Button
                            onClick={submit}
                            disabled={busy || !canWrite || !draft.title.trim()}
                            title={canWrite ? undefined : NO_WRITE}
                        >
                            {busy ? 'Enregistrement…' : card ? 'Enregistrer' : 'Créer'}
                        </Button>
                    </>
                ) : undefined
            }
        >
            <div className={styles.form}>
                {card && (
                    <nav className={styles.tabs}>
                        {tabButton('settings', 'edit', 'Modifier')}
                        {tabButton('work', 'square-check', 'Suivi')}
                        {tabButton('chat', 'chat', 'Discussion', card.unread)}
                    </nav>
                )}

                <div className={styles.tabPanel}>
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

                    {/* Masqués et non démontés : le fil garde ses messages et son
                            abonnement, le suivi une édition en cours, là où un
                            remontage rejouerait un « Chargement… » au retour. */}
                    {card && (
                        <>
                            <div
                                className={tab === 'work' ? styles.workTab : styles.tabHidden}
                                aria-hidden={tab === 'work' ? undefined : true}
                            >
                                {subtasks}
                            </div>
                            <div
                                className={tab === 'chat' ? styles.chatTab : styles.tabHidden}
                                aria-hidden={tab === 'chat' ? undefined : true}
                            >
                                <Chat
                                    cardId={card.id}
                                    members={members}
                                    meUserId={meUserId}
                                    canWrite={canChat}
                                    active={open && tab === 'chat'}
                                    onRead={onRead}
                                />
                            </div>
                        </>
                    )}

                    {!card && subtasks}

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            </div>
        </Dialog>
    );
}

export default CardDialog;
