import { useEffect, useMemo, useState } from 'react';
import { FEATURE_REGISTRY, notificationFeatureSchema, WORKSPACE_CAPABILITIES } from 'deveye-types';
import type { FeatureAccess, WorkspaceCapability, WorkspaceFeatureGrant, WorkspaceRole } from 'deveye-types';

import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { Dialog } from '@/Components/Dialog';
import SegmentedControl from '@/Components/SegmentedControl';
import TextInput from '@/Components/TextInput';
import { placedFeatureIds, useHomeLayout } from '@/stores/homeLayout';
import shell from '@/Components/FeatureSettings/FeatureSettings.module.css';
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
 * La forme est celle de la **coquille de réglages** (mêmes classes que
 * `FeatureSettings` : navigation à gauche, panneau à droite), parce que c'est
 * la même chose : des catégories qui s'énumèrent de haut en bas. En tête,
 * « Espace », le gouvernement de l'espace lui-même ; sous le trait, une entrée
 * par fonctionnalité, dont le panneau porte le niveau d'accès ET ses réglages
 * propres, à commencer par la gestion de ses canaux d'alerte, par
 * fonctionnalité depuis la migration 093.
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
    'workspace.layout': 'Modifier la disposition de l’accueil'
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

/** Les fonctionnalités qui émettent des notifications : les seules à canaux. */
const NOTIFYING = new Set<string>(notificationFeatureSchema.options);

/** La section affichée : le gouvernement de l'espace, ou une fonctionnalité. */
type RoleSection = 'space' | (typeof FEATURE_REGISTRY)[number]['id'];

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
    /** Gestion des canaux d'alerte, par fonctionnalité émettrice. */
    const [channels, setChannels] = useState<Record<string, boolean>>({});
    const [section, setSection] = useState<RoleSection>('space');
    /** La navigation dépliée sur tout le registre, pas seulement l'accueil. */
    const [showAll, setShowAll] = useState(false);

    /**
     * La navigation s'ouvre sur les fonctionnalités que l'accueil de l'espace
     * montre (dossiers compris) : c'est presque toujours là-dessus qu'un rôle
     * se règle. Le filtre est l'accueil, et lui seul : les droits accordés hors
     * accueil ne sont pas cachés en silence, le bouton de dépliage en donne le
     * compte. Seul garde-fou : un accueil qui ne montre rien déplie tout
     * d'office, une liste vide d'où rien ne se règle n'aidant personne.
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

    useEffect(() => {
        if (!open) return;
        setSection('space');
        setShowAll(false);
        setName(role?.name ?? '');
        setColor(role?.color ?? '#22d3ee');
        setCapabilities(role?.capabilities ?? []);
        setFeatures(
            Object.fromEntries(
                FEATURE_REGISTRY.map((f) => [f.id, role?.features.find((g) => g.feature === f.id)?.access ?? 'none'])
            )
        );
        setChannels(
            Object.fromEntries(
                FEATURE_REGISTRY.map((f) => [f.id, role?.features.find((g) => g.feature === f.id)?.channels ?? false])
            )
        );
    }, [open, role]);

    const toggle = (c: WorkspaceCapability): void =>
        setCapabilities((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

    const submit = (): void => {
        if (!name.trim()) return;
        onSubmit({
            name: name.trim(),
            color,
            capabilities,
            features: FEATURE_REGISTRY.flatMap<WorkspaceFeatureGrant>((f) => {
                const a = features[f.id];
                if (a !== 'read' && a !== 'write') return [];
                // Les canaux ne se gèrent pas sur une fonctionnalité qui n'en
                // émet pas, ni sur une qu'on ne voit pas : le champ est alors
                // rangé à false plutôt que laissé à un état sans objet.
                return [{ feature: f.id, access: a, channels: NOTIFYING.has(f.id) && (channels[f.id] ?? false) }];
            })
        });
    };

    const active = FEATURE_REGISTRY.find((f) => f.id === section) ?? null;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={role ? `Modifier « ${role.name} »` : 'Nouveau rôle'}
            width={760}
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

            <div className={`${shell.layout} ${styles.roleLayout}`}>
                {/* La navigation est bâtie ici plutôt qu'avec `SideNav` : elle
                    porte un trait de séparation, un point d'état par
                    fonctionnalité et le bouton de dépliage, que la coquille
                    n'a pas à connaître. Les classes, elles, sont les siennes. */}
                <nav className={shell.nav} role='tablist' aria-label='Sections du rôle'>
                    <button
                        type='button'
                        role='tab'
                        aria-selected={section === 'space'}
                        className={`${shell.navItem} ${section === 'space' ? shell.navItemActive : ''}`}
                        onClick={() => setSection('space')}
                    >
                        <span className='icon icon-settings' />
                        <span className={shell.navLabel}>Espace</span>
                        {capabilities.length > 0 && <span className={shell.navBadge}>{capabilities.length}</span>}
                    </button>

                    <div className={styles.navSpacer} aria-hidden='true' />

                    {featureRows.map((f) => {
                        const access = features[f.id] ?? 'none';
                        return (
                            <button
                                key={f.id}
                                type='button'
                                role='tab'
                                aria-selected={section === f.id}
                                className={`${shell.navItem} ${section === f.id ? shell.navItemActive : ''}`}
                                title={
                                    access === 'none'
                                        ? 'Aucun accès'
                                        : access === 'read'
                                          ? 'Lecture'
                                          : 'Lecture et écriture'
                                }
                                onClick={() => setSection(f.id)}
                            >
                                <span className={`icon icon-${f.icon}`} />
                                <span className={shell.navLabel}>{f.label}</span>
                                {/* Le point dit d'un coup d'œil ce que le rôle
                                    accorde : accent = écriture, éteint =
                                    lecture, rien = aucun accès. */}
                                {access !== 'none' && (
                                    <span className={styles.navDot} data-access={access} aria-hidden='true' />
                                )}
                            </button>
                        );
                    })}

                    {collapsed && (
                        <button type='button' className={styles.showAllBtn} onClick={() => setShowAll(true)}>
                            {FEATURE_REGISTRY.length - featureRows.length === 1
                                ? 'Voir la fonctionnalité restante'
                                : `Voir les ${FEATURE_REGISTRY.length - featureRows.length} autres`}
                            {hiddenGranted > 0 &&
                                (hiddenGranted === 1 ? ' (dont 1 accordée)' : ` (dont ${hiddenGranted} accordées)`)}
                        </button>
                    )}
                </nav>

                <div className={shell.panel}>
                    {active === null ? (
                        <section className={shell.section}>
                            <span className={shell.sectionLabel}>Administration de l’espace</span>
                            <p className={shell.sectionHint}>
                                Ce que ce rôle permet de gouverner sur l’espace lui-même, indépendamment des
                                fonctionnalités.
                            </p>
                            <div className={`${styles.card} ${styles.rowList}`}>
                                {WORKSPACE_CAPABILITIES.map((c) => (
                                    <Checkbox
                                        key={c}
                                        className={styles.checkRow}
                                        checked={capabilities.includes(c)}
                                        onChange={() => toggle(c)}
                                    >
                                        {CAPABILITY_LABELS[c]}
                                    </Checkbox>
                                ))}
                            </div>
                        </section>
                    ) : (
                        <section className={shell.section}>
                            <span className={shell.sectionLabel}>{active.label}</span>
                            {/* Ce que le droit recouvre, du registre : l'intitulé
                                « Déploiement » ne dit pas seul que `write` permet
                                une mise en production. */}
                            <p className={shell.sectionHint}>{active.description}</p>

                            {/* « Aucun » est un choix explicite, pas une absence de
                                ligne. Les exceptions par élément (masquer une base à
                                un rôle, un service en lecture seule) se règlent sur
                                l'élément lui-même, dans ses réglages. */}
                            <div className={styles.grantField}>
                                <span className={styles.grantFieldLabel}>Accès</span>
                                <SegmentedControl
                                    aria-label={`Accès à ${active.label}`}
                                    value={features[active.id] ?? 'none'}
                                    options={ACCESS_OPTIONS}
                                    onChange={(v) => setFeatures((prev) => ({ ...prev, [active.id]: v }))}
                                />
                            </div>

                            {NOTIFYING.has(active.id) && (
                                <div className={styles.grantExtra}>
                                    <Checkbox
                                        className={styles.checkRow}
                                        checked={
                                            (features[active.id] ?? 'none') !== 'none' && (channels[active.id] ?? false)
                                        }
                                        disabled={(features[active.id] ?? 'none') === 'none'}
                                        onChange={() =>
                                            setChannels((prev) => ({
                                                ...prev,
                                                [active.id]: !(prev[active.id] ?? false)
                                            }))
                                        }
                                    >
                                        Gérer ses canaux d’alerte
                                    </Checkbox>
                                    <p className={shell.fieldHint}>
                                        Déclarer, corriger et supprimer les canaux de {active.label}, et lire leurs
                                        destinations. Sans ce droit, le rôle peut router vers les canaux existants sans
                                        voir leurs adresses. Demande au moins la lecture de la fonctionnalité.
                                    </p>
                                </div>
                            )}
                        </section>
                    )}
                </div>
            </div>
        </Dialog>
    );
}
