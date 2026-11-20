import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import {
    placedFeatureIds,
    type FeatureId,
    type HomeSection,
    type ShortcutItem,
    type WorkspaceRole
} from '@deveye/types';

import { errorNote } from '@/api/useResource';
import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import ErrorNote, { type ErrorNoteInput } from '@/Components/ErrorNote';
import TextInput from '@/Components/TextInput';
import { useDevices } from '@/devicesProvider';
import { foldText } from '@/foldText';
import { addDevice, addFeature, getHomeLayout, placedDeviceIds, useHomeLayout } from '@/stores/homeLayout';
import { invalidate } from '@/stores/invalidation';
import { setPermissions, useActiveWorkspace, useWorkspacePermissions } from '@/stores/workspace';
import {
    FEATURE_CATEGORIES,
    FEATURE_CATEGORY_ICON,
    FEATURE_CATEGORY_LABEL,
    visibleFeatureCatalog,
    type FeatureCategory
} from '../catalog';
import { allRecommendedPlaced, recommendedFeatures } from '../starters';
import { FeatureArt, type ArtId } from '../art';
import { FeatureAccessStep, rolesWithout, type AccessChoice } from './FeatureAccessStep';
import { ShortcutForm } from './ShortcutForm';
import styles from './organize.module.css';

/** Les rayons du marché : les fonctionnalités mises en avant, l'étal complet,
 *  les appareils, les rayons du catalogue, puis la création d'un raccourci. */
type Rayon = 'recommended' | 'all' | 'devices' | FeatureCategory | 'shortcut';

// « Par appareil » et non « Appareils », qui est le nom de la feature : deux
// boutons du même nom dans un même marché se confondent.
const RAYON_LABEL: Record<'recommended' | 'all' | 'devices' | 'shortcut', string> = {
    recommended: 'Recommandé',
    all: 'Tout',
    devices: 'Par appareil',
    shortcut: 'Raccourcis'
};

const RAYON_ICON: Record<'recommended' | 'all' | 'devices' | 'shortcut', string> = {
    recommended: 'star',
    all: 'list',
    devices: 'server',
    shortcut: 'move-to-right'
};

/** Le rail en trois groupes séparés d'un filet : par où entrer, ce qui vient
 *  de vous (machines, liens), les fonctionnalités par usage. */
const RAIL_GROUPS: Rayon[][] = [['recommended', 'all'], ['devices', 'shortcut'], [...FEATURE_CATEGORIES]];

function rayonLabel(rayon: Rayon): string {
    return rayon in RAYON_LABEL
        ? RAYON_LABEL[rayon as keyof typeof RAYON_LABEL]
        : FEATURE_CATEGORY_LABEL[rayon as FeatureCategory];
}

function rayonIcon(rayon: Rayon): string {
    return rayon in RAYON_ICON
        ? RAYON_ICON[rayon as keyof typeof RAYON_ICON]
        : FEATURE_CATEGORY_ICON[rayon as FeatureCategory];
}

/** Un article de l'étal : une carte qui pose quelque chose sur l'accueil. */
interface MarketItem {
    key: string;
    rayon: Rayon;
    icon: string;
    /** La vignette en tête de carte : ce à quoi ressemble l'écran qu'on ajoute. */
    art: ArtId;
    /** Celle qu'un module dessine lui-même, quand il en fournit une. */
    Art?: ComponentType;
    title: string;
    description: string;
    /** Mots supplémentaires que la recherche doit trouver (plateforme d'un appareil…). */
    keywords?: string;
    /** Élément posé à droite du titre (la pastille d'état d'un appareil). */
    badge?: ReactNode;
    /** Déjà sur l'accueil : la carte reste à l'étal, éteinte, plutôt que d'en
     *  disparaître ; une seule tuile par fonctionnalité ou par appareil. */
    placed?: boolean;
    /** Mise en avant : le rayon « Recommandé » traverse les autres. */
    recommended?: boolean;
    onPick: () => void;
}

/**
 * Le repère du coin d'une carte, dessiné ici : `icon-plus` de `Styles/icons.css`
 * rend un pâté à cette taille. La pastille porte la couleur, pas le glyphe.
 */
function MarketMark({ placed }: { placed: boolean }) {
    return (
        <span className={`${styles.marketMark} ${placed ? styles.marketMarkDone : ''}`} aria-hidden='true'>
            <svg viewBox='0 0 16 16' className={styles.marketMarkGlyph} role='presentation' focusable='false'>
                <path
                    d={placed ? 'M3.6 8.4 6.6 11.4 12.4 4.8' : 'M8 3.6v8.8M3.6 8h8.8'}
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2.2'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                />
            </svg>
        </span>
    );
}

export interface AddTileMarketProps {
    /** Section à garnir, ou `null` quand le marché est fermé. */
    section: HomeSection | null;
    /** Quand renseigné, la popup édite ce raccourci au lieu d'ouvrir le marché. */
    editShortcut?: ShortcutItem | null;
    onClose: () => void;
}

/** La fonctionnalité choisie, en attente de la réponse à « qui y aura accès ? ». */
interface AccessStepState {
    featureId: FeatureId;
    title: string;
    roles: WorkspaceRole[];
    choices: Record<number, AccessChoice>;
}

/**
 * Le marché : une seule popup pour tout ce qui se pose sur l'accueil. Le rayon
 * des raccourcis est un formulaire, pas un catalogue. Les dossiers ne passent
 * pas par ici : un dossier ne se remplit qu'en y tirant des cartes déjà posées,
 * son bouton est au bout de la section. Chaque ajout referme.
 */
export function AddTileMarket({ section, editShortcut, onClose }: AddTileMarketProps) {
    const layout = useHomeLayout();
    const { devices } = useDevices();
    const workspace = useActiveWorkspace();
    const { isOwner, can } = useWorkspacePermissions();
    const [rayon, setRayon] = useState<Rayon>('all');
    const [query, setQuery] = useState('');
    const [accessStep, setAccessStep] = useState<AccessStepState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    const open = section !== null;
    const sectionId = section?.id ?? null;

    // Une réouverture repart du rayon d'entrée, pas d'une popup déjà filtrée :
    // les recommandées tant qu'il en reste à poser, l'étal complet ensuite.
    // L'état est lu au store plutôt qu'au rendu, pour décrire l'accueil de
    // l'instant où la popup s'ouvre.
    useEffect(() => {
        if (!open) return;
        setRayon(allRecommendedPlaced(getHomeLayout()) ? 'all' : 'recommended');
        setQuery('');
        setAccessStep(null);
        setError(null);
    }, [open]);

    /**
     * Dans un espace partagé, qui gouverne les rôles répond d'abord à « qui y
     * aura accès ? » quand un rôle n'ouvre pas la fonctionnalité. Sans ce droit,
     * l'ajout reste direct : les autres voient la tuile grisée, ce qui les
     * renseigne déjà.
     */
    const pickFeature = async (sectionId: string, featureId: FeatureId, title: string): Promise<void> => {
        const canGrant = workspace?.kind === 'shared' && (isOwner || can('workspace.roles'));
        if (canGrant && !busy) {
            setBusy(true);
            setError(null);
            try {
                const { roles } = await ws.send('workspace.roleList', {});
                if (rolesWithout(roles, featureId).length > 0) {
                    setAccessStep({ featureId, title, roles, choices: {} });
                    return;
                }
            } catch (e) {
                setError(errorNote(e, 'Lecture des rôles impossible.'));
                return;
            } finally {
                setBusy(false);
            }
        }
        addFeature(sectionId, featureId);
        onClose();
    };

    const confirmAccess = async (): Promise<void> => {
        if (sectionId === null || accessStep === null || busy) return;
        const grants = Object.entries(accessStep.choices).flatMap(([roleId, access]) =>
            access === 'none' ? [] : [{ roleId: Number(roleId), access }]
        );
        setBusy(true);
        setError(null);
        try {
            if (grants.length > 0) {
                await ws.send('workspace.featureAccessSet', { feature: accessStep.featureId, grants });
                // L'auteur est exclu de la diffusion : l'écran des rôles et ses
                // propres droits se relisent ici. Les droits seuls : la
                // disposition rendue par `workspace.activate` précède la tuile,
                // pas encore enregistrée, et l'effacerait.
                invalidate('workspace.roleList');
                if (!isOwner) {
                    void ws
                        .send('workspace.activate', {})
                        .then((res) => setPermissions(res.permissions))
                        .catch(() => {});
                }
            }
        } catch (e) {
            setError(errorNote(e, 'Ouverture de l’accès impossible.'));
            return;
        } finally {
            setBusy(false);
        }
        addFeature(sectionId, accessStep.featureId);
        onClose();
    };

    const recommendedIds = new Set<string>(recommendedFeatures().map((feature) => feature.id));

    // Rien à recommander (aucun de ces modules installé) : le rayon s'efface,
    // un rail vide ne s'explique pas.
    const railGroups =
        recommendedIds.size > 0 ? RAIL_GROUPS : RAIL_GROUPS.map((group) => group.filter((id) => id !== 'recommended'));

    /** L'étal, volontairement non mémorisé : la liste de dépendances serait plus
     *  longue que le calcul, pour une quarantaine d'articles. */
    const items: MarketItem[] = [];
    if (sectionId !== null) {
        // Un appareil déjà posé n'est pas reproposé : il n'a qu'une carte.
        const placedDevices = new Set<string>(placedDeviceIds(layout));
        for (const device of devices) {
            if (device.status === 'archived') continue;
            const placed = placedDevices.has(device.id);
            items.push({
                key: `device:${device.id}`,
                rayon: 'devices',
                icon: 'server',
                art: 'device',
                title: device.name,
                description: device.online ? 'En ligne' : 'Hors ligne',
                keywords: device.platform,
                badge: <span className={`${styles.addDot} ${device.online ? styles.online : styles.offline}`} />,
                placed,
                onPick: () => {
                    addDevice(sectionId, device.id);
                    onClose();
                }
            });
        }

        // Tout le catalogue visible est proposé : le droit d'ouvrir une feature
        // est celui du rôle, et la grille le dit tuile par tuile (« Accès
        // restreint ») plutôt que de cacher ce qu'un autre membre a posé.
        const placedFeatures = new Set<string>(placedFeatureIds(layout));
        for (const feature of visibleFeatureCatalog()) {
            items.push({
                key: `feature:${feature.id}`,
                rayon: feature.category,
                icon: feature.icon,
                art: feature.id,
                Art: feature.Art,
                title: feature.title,
                description: feature.description,
                placed: placedFeatures.has(feature.id),
                recommended: recommendedIds.has(feature.id),
                onPick: () => void pickFeature(sectionId, feature.id, feature.title)
            });
        }

        // Le rayon des raccourcis est un formulaire, pas un article ; annoncé
        // dans l'étal pour qu'on y arrive depuis « Tout ».
        items.push({
            key: 'shortcut',
            rayon: 'shortcut',
            icon: 'move-to-right',
            art: 'shortcut',
            title: 'Créer un raccourci',
            description: 'Un lien épinglé, avec son aperçu récupéré automatiquement.',
            keywords: 'lien url site favori raccourci',
            // La recherche est vidée avec : elle prend le pas sur le rayon dans
            // l'affichage.
            onPick: () => {
                setQuery('');
                setRayon('shortcut');
            }
        });
    }

    const search = foldText(query.trim());

    /**
     * Une recherche traverse les rayons : chercher « git » depuis les appareils
     * doit trouver la fonctionnalité. Le rayon ne reprend la main que le champ
     * vide.
     */
    const shown = search
        ? items.filter((item) => foldText(`${item.title} ${item.description} ${item.keywords ?? ''}`).includes(search))
        : rayon === 'all'
          ? items
          : rayon === 'recommended'
            ? items.filter((item) => item.recommended)
            : items.filter((item) => item.rayon === rayon);

    /** Combien d'articles par rayon, posés ou non : c'est un inventaire, pas un stock. */
    const counts = new Map<Rayon, number>();
    for (const item of items) counts.set(item.rayon, (counts.get(item.rayon) ?? 0) + 1);
    counts.set('all', items.length);
    counts.set('recommended', items.filter((item) => item.recommended).length);

    // Le rayon des raccourcis montre son formulaire, pas des cartes, sauf
    // pendant une recherche, qui traverse tout et reprend la main sur l'affichage.
    const showShortcutForm = !search && rayon === 'shortcut';

    const editing = editShortcut != null && section !== null;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={
                editing
                    ? 'Modifier le raccourci'
                    : accessStep
                      ? `Qui aura accès à ${accessStep.title} ?`
                      : "Ajouter à l'accueil"
            }
            width={editing || accessStep ? 560 : 860}
            onSubmit={accessStep ? () => void confirmAccess() : undefined}
            footer={
                accessStep ? (
                    <>
                        <Button
                            variant='secondary'
                            disabled={busy}
                            onClick={() => {
                                setAccessStep(null);
                                setError(null);
                            }}
                        >
                            Retour
                        </Button>
                        <Button onClick={() => void confirmAccess()} disabled={busy}>
                            {busy ? 'Ajout…' : 'Ajouter la tuile'}
                        </Button>
                    </>
                ) : undefined
            }
        >
            <ErrorNote note={error} onDismiss={() => setError(null)} />
            {section !== null &&
                (editing ? (
                    <ShortcutForm sectionId={section.id} initial={editShortcut} onDone={onClose} />
                ) : accessStep ? (
                    <FeatureAccessStep
                        featureId={accessStep.featureId}
                        featureLabel={accessStep.title}
                        roles={accessStep.roles}
                        choices={accessStep.choices}
                        isOwner={isOwner}
                        onChange={(roleId, choice) =>
                            setAccessStep((prev) =>
                                prev ? { ...prev, choices: { ...prev.choices, [roleId]: choice } } : prev
                            )
                        }
                    />
                ) : (
                    <div className={styles.market}>
                        <TextInput
                            placeholder='Rechercher un appareil, une fonctionnalité…'
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            data-autofocus
                        />

                        <div className={styles.marketBody}>
                            <div className={styles.marketRails}>
                                {railGroups.flatMap((group, groupIndex) => [
                                    ...(groupIndex > 0
                                        ? [<span key={`sep${groupIndex}`} className={styles.marketRailSep} />]
                                        : []),
                                    ...group.map((id) => {
                                        // Le rayon de création ne compte rien : « 1 » en face de
                                        // « Raccourcis » se lirait comme un stock restant.
                                        const count = id === 'shortcut' ? undefined : counts.get(id);
                                        return (
                                            <button
                                                key={id}
                                                type='button'
                                                aria-pressed={!search && rayon === id}
                                                className={`${styles.marketRail} ${!search && rayon === id ? styles.marketRailOn : ''}`}
                                                onClick={() => {
                                                    setQuery('');
                                                    setRayon(id);
                                                }}
                                            >
                                                <span
                                                    className={`icon icon-${rayonIcon(id)} ${styles.marketRailIcon}`}
                                                />
                                                <span className={styles.marketRailLabel}>{rayonLabel(id)}</span>
                                                {count !== undefined && (
                                                    <span className={styles.marketRailCount}>{count}</span>
                                                )}
                                            </button>
                                        );
                                    })
                                ])}
                            </div>

                            <div className={styles.marketPane}>
                                {showShortcutForm ? (
                                    <ShortcutForm sectionId={section.id} onDone={onClose} />
                                ) : shown.length === 0 ? (
                                    <p className={styles.addEmpty}>
                                        {search
                                            ? 'Rien ne correspond à cette recherche.'
                                            : rayon === 'devices'
                                              ? 'Aucun appareil connecté.'
                                              : 'Ce rayon est vide.'}
                                    </p>
                                ) : (
                                    <div className={styles.marketGrid}>
                                        {shown.map((item) => (
                                            <button
                                                key={item.key}
                                                type='button'
                                                className={`${styles.marketCard} ${item.placed ? styles.marketCardPlaced : ''}`}
                                                disabled={item.placed}
                                                title={item.placed ? 'Déjà sur l’accueil' : undefined}
                                                onClick={item.onPick}
                                            >
                                                <FeatureArt
                                                    id={item.art}
                                                    Art={item.Art}
                                                    className={styles.marketCardArt}
                                                />
                                                <span className={styles.marketCardBody}>
                                                    <span className={styles.marketCardHead}>
                                                        <span
                                                            className={`icon icon-${item.icon} ${styles.marketCardIcon}`}
                                                        />
                                                        <span className={styles.marketCardTitle}>{item.title}</span>
                                                        {item.badge}
                                                        <MarketMark placed={item.placed === true} />
                                                    </span>
                                                    {/* Le rayon n'est rappelé que quand l'étal les mélange. */}
                                                    {item.placed ? (
                                                        <span className={styles.marketCardRayon}>
                                                            Déjà sur l’accueil
                                                        </span>
                                                    ) : (
                                                        (search || rayon === 'all' || rayon === 'recommended') && (
                                                            <span className={styles.marketCardRayon}>
                                                                {rayonLabel(item.rayon)}
                                                            </span>
                                                        )
                                                    )}
                                                    <span className={styles.marketCardDesc}>{item.description}</span>
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
        </Dialog>
    );
}

export default AddTileMarket;
