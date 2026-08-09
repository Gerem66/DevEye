import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
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
import { useLiveSegment } from '@/live/useLiveSegment';
import { useLiveOutlines } from '@/live/useLiveOutline';
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
    /**
     * Le brouillon et ses rattachements.
     *
     * Ni le jalon ni les dépendances ne tiennent dans le brouillon chiffré : ce
     * sont des commandes à part, qui exigent une carte déjà née. Ils voyagent
     * donc à côté, et **rien ne part avant « Enregistrer »** — les poser au
     * moment du clic dans le sélecteur écrivait sur le serveur à chaque
     * hésitation, et laissait derrière soi des modifications qu'« Annuler »
     * n'annulait pas. L'appelant rapproche cet état de celui qu'il connaît et
     * n'envoie que la différence.
     */
    onSubmit: (draft: ProjectCardDraft, links: { milestoneId: number | null; blockedBy: number[] }) => void;
    /**
     * La liste de sous-tâches vient de changer, sur une carte **existante**.
     *
     * Elle ne suit pas le sort du reste du formulaire : cocher une case est un
     * geste d'avancement, pas une modification qu'on met au propre — et il se
     * fait depuis l'onglet « Suivi », qui n'a pas de bouton pour l'enregistrer.
     * Chaque ajout, retrait ou coche part donc sur-le-champ.
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
 * Les deux visages d'une tâche existante.
 *
 * `work` — le fil et les sous-tâches, ce pour quoi on rouvre une tâche dix fois
 * par jour. `settings` — la description et les réglages, qu'on renseigne une
 * fois. Une création n'a pas de fil à suivre : elle reste sur `settings`.
 */
type CardTab = 'work' | 'settings';

/**
 * Le brouillon s'écarte-t-il de la carte enregistrée ?
 *
 * La liste de sous-tâches n'y figure pas : elle part à chaque geste, il n'y a
 * donc jamais rien d'elle en attente. L'y comparer ne ferait que retenir une
 * fermeture pour un enregistrement déjà fait.
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
    /** L'onglet ouvert. Une création n'en a pas : elle est toujours sur `settings`. */
    const [tab, setTab] = useState<CardTab>('work');
    const [itemLabel, setItemLabel] = useState('');
    /** Le jalon choisi. Hors du brouillon — voir `onSubmit` dans les props. */
    const [milestoneId, setMilestoneId] = useState<number | null>(null);
    /** Les tâches déclarées bloquantes. Idem : posées à l'enregistrement. */
    const [blockerIds, setBlockerIds] = useState<number[]>([]);
    /** La sous-tâche dont on vient de demander le retrait ; `null` = personne. */
    const [removing, setRemoving] = useState<ProjectChecklistItem | null>(null);
    /**
     * Son libellé, gardé à part : la popup s'efface en fondu, et lire
     * « «  » quittera la liste » pendant sa sortie serait pire que rien.
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
     * Remet la popup à l'état de la carte qu'on vient d'ouvrir.
     *
     * Déclenchée sur l'**identifiant** de la carte et non sur l'objet : choisir
     * un jalon remplace la carte détenue par l'appelant (voir `setCardMilestone`
     * dans `ProjectDetail`), et rejouer la remise à zéro là-dessus renverrait le
     * brouillon à sa valeur enregistrée et l'onglet à son défaut — en plein
     * milieu d'une saisie.
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
     * Le dernier niveau de présence : l'onglet ouvert dans cette popup.
     *
     * Déclaré seulement quand la popup l'est **et** qu'elle porte une carte : ce
     * composant reste monté en permanence (`open` est une prop, pas un
     * démontage), et une création n'est pas un lieu qu'on partage.
     *
     * Ce qui se joue là n'est pas qu'un halo : deux personnes sur la même tâche
     * mais l'une sur la discussion et l'autre sur les champs ne sont pas au même
     * endroit, et n'ont pas à se voir promener leur curseur en travers de ce que
     * l'autre regarde.
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
     * La liste de sous-tâches suit la carte, y compris quand elle bouge ailleurs.
     *
     * Elle est la seule à le faire, et c'est cohérent avec le reste : les autres
     * champs attendent « Enregistrer », donc les rafraîchir effacerait une saisie
     * en cours ; la liste, elle, part à chaque geste — il n'y a jamais rien d'elle
     * en attente, et ce qu'affiche le serveur fait autorité.
     *
     * La comparaison évite le rendu inutile qu'un simple `setDraft` produirait à
     * chaque re-sollicitation, et surtout la seconde d'aller-retour pendant
     * laquelle notre propre coche, déjà posée localement, reviendrait en arrière.
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
     * Pose la nouvelle liste — et l'envoie aussitôt, sur une carte existante.
     *
     * Le brouillon local est mis à jour dans tous les cas : c'est lui qu'on
     * affiche, et il doit suivre le clic sans attendre l'aller-retour. À la
     * création, il n'y a personne à qui l'envoyer : la liste part avec le reste
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

    /**
     * Retire la sous-tâche confirmée.
     *
     * Le retrait n'est pas rattrapable : la ligne part pour de bon, et rien dans
     * ce dialogue ne la ramène — d'où la confirmation qui y mène.
     */
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
     * Ce qui reste à enregistrer.
     *
     * Le jalon et les dépendances en font partie depuis qu'ils attendent
     * « Enregistrer » comme le reste : c'est ce drapeau que le Dialog consulte
     * pour retenir une fermeture, et l'oublier ici les laisserait filer sans un
     * mot.
     */
    const changed =
        isChanged(draft, card) ||
        (card !== null &&
            (milestoneId !== card.milestoneId ||
                blockerIds.length !== savedBlockerIds.length ||
                blockerIds.some((id) => !savedBlockerIds.includes(id))));

    /**
     * La hauteur du contenu de l'onglet, mesurée pour être animée.
     *
     * Mesurée et non calculée : les deux onglets n'ont ni le même nombre de
     * champs ni la même mise en page, et l'un des deux contient une discussion
     * dont la taille dépend du fil. Un observateur suffit — il rattrape aussi
     * bien le changement d'onglet que le message qui vient d'arriver ou la
     * sous-tâche qu'on ajoute.
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

    /**
     * Jalon, assignation, priorité, dates, estimation.
     *
     * Un seul bloc, deux places : à la création on les renseigne, ils sont donc
     * à l'air libre ; sur une tâche existante on vient surtout lire la
     * discussion et cocher des sous-tâches, ils passent alors en repli.
     *
     * Le jalon ouvre la série et non les dates : avec les dépendances à sa
     * droite, la première ligne dit où la tâche se situe dans le projet ; les
     * suivantes, qui s'en occupe et quand.
     */
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
                 * La frise trace ces liens en flèches (voir `Timeline`). Le
                 * serveur refuse les cycles : A ne peut pas attendre B qui
                 * attend A.
                 */}
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
                        {/* Choisir une tâche l'ajoute : le choix *est* l'intention,
                            un bouton de confirmation ne demandait que de répéter
                            ce qu'on venait de dire. Le sélecteur revient aussitôt
                            sur son intitulé, prêt pour la suivante. */}
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

    /* Les sous-tâches ont leur encart : c'est une liste qu'on coche, pas un
       champ de formulaire de plus. Centré à la création, en colonne contre la
       discussion sur une tâche existante. */
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

            {/* Le retrait se confirme : rien dans ce dialogue ne ramène une
                sous-tâche effacée. Déclarée ici, contre ce qu'elle protège — un
                Dialog se rend dans un portail, sa place dans l'arbre n'a donc
                aucun effet de mise en page, et la pile de fermeture est
                chronologique : Échap annule le retrait sans refermer la tâche
                dessous. */}
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
            // Sur « Suivi », l'entête porte le titre de la tâche : c'est de
            // celle-ci qu'on suit l'avancement, pas d'un formulaire. Sur
            // « Modifier », il redevient l'intitulé de ce qu'on y fait — le
            // titre, lui, y est un champ comme les autres.
            title={card ? (tab === 'work' ? draft.title || 'Sans titre' : 'Modifier la tâche') : 'Nouvelle tâche'}
            // Plus large en édition : la discussion et les sous-tâches y
            // partagent une ligne, et deux colonnes de 350 px chacune ne se
            // lisent ni l'une ni l'autre. À la création, un formulaire seul n'a
            // rien à faire de cette largeur.
            width={card ? 980 : 720}
            // Ni `tall` ni `fill` : la rangée « discussion + sous-tâches » est
            // désormais bornée par son propre CSS (`.workRow`), donc la popup
            // n'a plus besoin d'un mode de mise en page pour lui donner une
            // hauteur définie — elle suit son contenu, comme n'importe quel
            // formulaire, et les deux encarts défilent chacun chez eux.
            onSubmit={submit}
            holdSecrecy
            // Les sous-tâches vivent dans le brouillon et n'atteignent le serveur
            // qu'à l'enregistrement — or « Enregistrer » n'est pas sur l'onglet
            // où on les coche. La garde du Dialog rattrape le cas : refermer avec
            // des changements en attente propose de les garder.
            dirty={card !== null && changed}
            onSave={submit}
            footer={
                // Uniquement sur l'onglet des réglages : sur « Suivi », on lit un
                // fil et on coche des cases, trois boutons de formulaire sous le
                // nez n'y correspondent à rien. Le formulaire de création, lui,
                // n'a pas d'onglets et garde les siens.
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
                {/* Deux onglets sur une tâche existante — le même motif que la
                    navigation du projet, et la même feuille de style. On vient
                    ici pour suivre l'avancement ; le reste ne se retouche qu'à
                    l'occasion. À la création, il n'y a rien à suivre : le
                    formulaire se donne d'un bloc. */}
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

                {/* La hauteur suit le contenu de l'onglet en glissant : les deux
                    n'ont pas la même, et la popup passait de l'une à l'autre
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
                                {/* Le titre est dans l'onglet qui le modifie :
                                    sur « Suivi », il est déjà en tête de popup,
                                    et l'y répéter dans un champ ne servait qu'à
                                    repousser la discussion vers le bas. */}
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

                        {/* Le fil n'existe que sur une carte déjà créée : il lui
                            est rattaché par son identifiant. Les sous-tâches lui
                            tiennent compagnie sur la même ligne — c'est ensemble
                            qu'on les consulte, et l'une sous l'autre quand la
                            place manque.

                            Masquée et non démontée en passant sur « Modifier » :
                            le fil garde ainsi ses messages et son abonnement, là
                            où un remontage rejouait un « Chargement… » au retour,
                            juste pendant que la popup change de taille. */}
                        {card && (
                            <div
                                className={tab === 'work' ? styles.workRow : styles.tabHidden}
                                aria-hidden={tab === 'work' ? undefined : true}
                            >
                                <Chat cardId={card.id} members={members} meUserId={meUserId} canWrite={canWrite} />
                                {subtasks}
                            </div>
                        )}

                        {/* À la création, l'encart est seul sous le formulaire. */}
                        {!card && subtasks}

                        {error && <p className={styles.error}>{error}</p>}
                    </div>
                </motion.div>
            </div>
        </Dialog>
    );
}

export default CardDialog;
