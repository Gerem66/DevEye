import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { FEATURE_REGISTRY, WORKSPACE_CAPABILITIES } from 'deveye-types';
import type { FeatureAccess, WorkspaceCapability, WorkspaceFeatureGrant, WorkspaceRole } from 'deveye-types';

import { placedFeatureIds, useHomeLayout } from '@/stores/homeLayout';

import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { Dialog } from '@/Components/Dialog';
import SegmentedControl from '@/Components/SegmentedControl';
import TextInput from '@/Components/TextInput';
import Tabs from './Tabs';
import styles from './Workspace.module.css';

/**
 * Édition d'un rôle : son identité **et** ses droits, dans une seule popup.
 *
 * Un détour a existé : l'identité ici, les droits dans une matrice globale
 * rôles × droits sous un onglet Permissions. Retiré : la grille répondait à
 * « qui peut ceci ? » mais l'usage réel est « configurer CE rôle », et couper un
 * rôle en deux écrans obligeait à savoir lequel des deux détenait quoi. Un rôle
 * se règle entier, là où on l'a créé.
 *
 * Entier, mais en deux volets : tout à la suite, la popup s'étirait en colonne
 * (six droits d'administration puis une ligne par fonctionnalité). La barre
 * d'onglets sépare ce qui touche à l'espace de ce qui touche aux
 * fonctionnalités ; le nom et la couleur, communs aux deux, restent en tête.
 *
 * Les intitulés des features viennent du **registre** (`FEATURE_REGISTRY`),
 * plus d'une table locale : c'est ce qui garantit qu'une fonctionnalité ajoutée
 * apparaît ici sans qu'on y pense.
 */

/** Intitulés en clair : l'enum technique ne se montre pas à l'utilisateur. */
const CAPABILITY_LABELS: Record<WorkspaceCapability, string> = {
    'workspace.manage': 'Renommer et supprimer l’espace',
    'workspace.members': 'Inviter et exclure des membres',
    'workspace.roles': 'Gérer les rôles et ce que chacun voit',
    'workspace.appearance': 'Modifier l’apparence',
    'workspace.layout': 'Modifier la disposition de l’accueil',
    'workspace.notifications': 'Gérer les canaux d’alerte'
};

/**
 * Trois niveaux, toujours les mêmes : des boutons collés plutôt qu'un menu
 * déroulant, qui cachait trois choix connus d'avance derrière un clic.
 */
const ACCESS_OPTIONS = [
    { value: 'none', label: 'Aucun', title: 'La fonctionnalité n’apparaît pas' },
    { value: 'read', label: 'Lecture', title: 'Consulter, sans rien modifier' },
    { value: 'write', label: 'Écriture', title: 'Lecture et écriture' }
] as const;

/** Les deux volets du formulaire. */
type RoleTab = 'space' | 'features';

/**
 * La courbe maison du mouvement de hauteur : départ franc, arrivée longue,
 * la même que le repli des sections de l'accueil.
 */
const VOLET_EASE = [0.32, 0.72, 0, 1] as const;

export interface RoleDraft {
    name: string;
    color: string;
    capabilities: WorkspaceCapability[];
    features: WorkspaceFeatureGrant[];
}

export interface RoleDialogProps {
    open: boolean;
    /** Rôle édité, ou `null` pour une création. */
    role: WorkspaceRole | null;
    busy: boolean;
    onClose: () => void;
    onSubmit: (draft: RoleDraft) => void;
}

export default function RoleDialog({ open, role, busy, onClose, onSubmit }: RoleDialogProps) {
    const [name, setName] = useState('');
    const [color, setColor] = useState('#22d3ee');
    const [capabilities, setCapabilities] = useState<WorkspaceCapability[]>([]);
    const [features, setFeatures] = useState<Record<string, FeatureAccess | 'none'>>({});
    const [tab, setTab] = useState<RoleTab>('space');
    /** Le volet Fonctionnalités déplié sur tout le registre, pas seulement l'accueil. */
    const [showAll, setShowAll] = useState(false);

    /**
     * Le volet s'ouvre sur les fonctionnalités que l'accueil de l'espace montre
     * (dossiers compris) : c'est presque toujours là-dessus qu'un rôle se
     * règle, et quinze lignes pour en toucher quatre noyaient l'essentiel.
     *
     * Le filtre est l'accueil, et lui seul. Une première version gardait aussi
     * toute ligne déjà accordée, mais un rôle généreux (les rôles de départ
     * accordent tout) ramenait alors le registre entier et le repli ne se
     * voyait jamais. Les droits accordés hors accueil ne sont pas cachés en
     * silence pour autant : le bouton de dépliage en donne le compte. Seul
     * garde-fou restant : un accueil qui ne montre rien déplie tout d'office,
     * une liste vide d'où rien ne se règle n'aidant personne.
     */
    const layout = useHomeLayout();
    const placed = useMemo(() => new Set<string>(placedFeatureIds(layout)), [layout]);
    const onHome = FEATURE_REGISTRY.filter((f) => placed.has(f.id));
    const collapsed = !showAll && onHome.length > 0 && onHome.length < FEATURE_REGISTRY.length;
    const featureRows = collapsed ? onHome : FEATURE_REGISTRY;
    /** Parmi les lignes repliées, celles que le rôle accorde déjà : dit sur le bouton. */
    const hiddenGranted = collapsed
        ? FEATURE_REGISTRY.filter((f) => !placed.has(f.id) && (features[f.id] ?? 'none') !== 'none').length
        : 0;

    const reduced = useReducedMotion() === true;
    /** La zone qui défile entre les onglets et le pied, seule à défiler. */
    const voletRef = useRef<HTMLDivElement>(null);
    /** Le contenu du volet actif, mesuré pour animer la hauteur du dialogue. */
    const [measureEl, setMeasureEl] = useState<HTMLDivElement | null>(null);
    const [voletHeight, setVoletHeight] = useState<number | null>(null);

    /**
     * La hauteur suit le volet actif, **mesurée** plutôt que devinée : framer ne
     * sait pas interpoler deux `auto`, il lui faut un nombre à viser. La mesure
     * vit sur un ref-callback : le contenu du dialogue n'existe que lorsqu'il
     * est ouvert, un effet posé au montage du composant ne trouverait rien.
     *
     * Au **plafond** de la hauteur réelle, jamais `offsetHeight` : ce dernier
     * arrondit au plus proche, et un contenu de 312,6 px réels clippé à 312
     * perd la rangée de pixels de sa bordure basse. Le plafond garantit que
     * l'arête de clip tombe sous le contenu, pas dedans.
     */
    useLayoutEffect(() => {
        if (!measureEl) return;
        const measure = () => setVoletHeight(Math.ceil(measureEl.getBoundingClientRect().height));
        const ro = new ResizeObserver(measure);
        ro.observe(measureEl);
        measure();
        return () => {
            ro.disconnect();
            setVoletHeight(null);
        };
    }, [measureEl]);

    // Changer de volet repart du haut : conserver le défilement de l'autre
    // volet montrerait le nouveau contenu à une position sans rapport.
    useEffect(() => {
        voletRef.current?.scrollTo({ top: 0 });
    }, [tab]);

    useEffect(() => {
        if (!open) return;
        setTab('space');
        setShowAll(false);
        setName(role?.name ?? '');
        setColor(role?.color ?? '#22d3ee');
        setCapabilities(role?.capabilities ?? []);
        setFeatures(
            Object.fromEntries(
                FEATURE_REGISTRY.map((f) => [f.id, role?.features.find((g) => g.feature === f.id)?.access ?? 'none'])
            )
        );
    }, [open, role]);

    const toggle = (c: WorkspaceCapability): void =>
        setCapabilities((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

    const grantedCount = Object.values(features).filter((a) => a !== 'none').length;

    const submit = (): void => {
        if (!name.trim()) return;
        onSubmit({
            name: name.trim(),
            color,
            capabilities,
            features: FEATURE_REGISTRY.flatMap<WorkspaceFeatureGrant>((f) => {
                const a = features[f.id];
                return a === 'read' || a === 'write' ? [{ feature: f.id, access: a }] : [];
            })
        });
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={role ? `Modifier « ${role.name} »` : 'Nouveau rôle'}
            width={620}
            fill
            onSubmit={submit}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || !name.trim()}>
                        {busy ? 'Enregistrement…' : role ? 'Enregistrer' : 'Créer'}
                    </Button>
                </>
            }
        >
            <div className={styles.nameRow}>
                <TextInput
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={64}
                    placeholder='Nom du rôle'
                    aria-label='Nom du rôle'
                />
                <input
                    type='color'
                    className={styles.colorInput}
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    aria-label='Couleur du rôle'
                />
            </div>

            {/* Les pastilles disent, depuis l'autre volet, combien de droits
                sont déjà cochés ici : le volet non affiché n'est jamais une
                boîte noire. */}
            <div className={styles.dialogTabs}>
                <Tabs<RoleTab>
                    tabs={[
                        { id: 'space', label: 'Espace', icon: 'shield', badge: capabilities.length },
                        { id: 'features', label: 'Fonctionnalités', icon: 'list', badge: grantedCount }
                    ]}
                    active={tab}
                    onSelect={setTab}
                />
            </div>

            {/* Le volet actif est la SEULE zone qui défile : le nom, les onglets
                et le pied restent en place (mode `fill` du dialogue). Le clip
                anime la hauteur d'un volet à l'autre, mesure à l'appui, et le
                contenu entrant se fond en place : la popup se redimensionne au
                lieu de sauter. */}
            <div className={styles.roleVolet} ref={voletRef}>
                <motion.div
                    className={styles.voletClip}
                    initial={false}
                    animate={{ height: voletHeight ?? 'auto' }}
                    transition={reduced ? { duration: 0 } : { duration: 0.3, ease: VOLET_EASE }}
                >
                    <div ref={setMeasureEl}>
                        <motion.div
                            key={tab}
                            initial={reduced ? false : { opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: 0.18 }}
                        >
                            {tab === 'space' ? (
                                <div className={`${styles.card} ${styles.rowList}`}>
                                    {WORKSPACE_CAPABILITIES.map((c) => {
                                        const on = capabilities.includes(c);
                                        return (
                                            <Checkbox
                                                key={c}
                                                className={styles.checkRow}
                                                checked={on}
                                                onChange={() => toggle(c)}
                                            >
                                                {CAPABILITY_LABELS[c]}
                                            </Checkbox>
                                        );
                                    })}
                                </div>
                            ) : (
                                /* Déplié, toutes listées, y compris les non
                                   accordées : « Aucun » est un choix explicite, pas
                                   une absence de ligne. Les exceptions par élément
                                   (masquer une base à un rôle, un service en lecture
                                   seule) se règlent sur l'élément lui-même, dans ses
                                   réglages. */
                                <>
                                    <div className={`${styles.card} ${styles.rowList}`}>
                                        {featureRows.map((f) => (
                                            <div key={f.id} className={styles.grantRow}>
                                                <span className={styles.grantLabel}>
                                                    <span className={styles.grantTitle}>
                                                        <span className={`icon icon-${f.icon}`} aria-hidden='true' />
                                                        {f.label}
                                                    </span>
                                                    {/* Ce que le droit recouvre, du registre : la ligne
                                                        « Déploiement » ne dit pas seule que `write`
                                                        permet une mise en production. */}
                                                    <span className={styles.grantHint}>{f.description}</span>
                                                </span>
                                                <SegmentedControl
                                                    aria-label={`Accès à ${f.label}`}
                                                    value={features[f.id] ?? 'none'}
                                                    options={ACCESS_OPTIONS}
                                                    onChange={(v) => setFeatures((prev) => ({ ...prev, [f.id]: v }))}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                    {/* Le dépliage passe par la même hauteur animée
                                        que le reste du volet : la popup grandit, elle
                                        ne saute pas. */}
                                    {collapsed && (
                                        <button
                                            type='button'
                                            className={styles.showAllBtn}
                                            onClick={() => setShowAll(true)}
                                        >
                                            {FEATURE_REGISTRY.length - featureRows.length === 1
                                                ? 'Voir la fonctionnalité restante'
                                                : `Voir les ${FEATURE_REGISTRY.length - featureRows.length} autres fonctionnalités`}
                                            {hiddenGranted > 0 &&
                                                (hiddenGranted === 1
                                                    ? ' (dont 1 accordée)'
                                                    : ` (dont ${hiddenGranted} accordées)`)}
                                        </button>
                                    )}
                                </>
                            )}
                        </motion.div>
                    </div>
                </motion.div>
            </div>
        </Dialog>
    );
}
