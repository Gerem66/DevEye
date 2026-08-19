import { useEffect, useState, type ReactNode } from 'react';
import type { HomeSection, ShortcutItem } from 'deveye-types';

import { Dialog } from '@/Components/Dialog';
import TextInput from '@/Components/TextInput';
import { useAuth } from '@/auth/AuthProvider';
import { useDevices } from '@/stores/devices';
import { useActiveWorkspace } from '@/stores/workspace';
import { addDevice, addFeature, placedDeviceIds, placedFeatureIds, useHomeLayout } from '@/stores/homeLayout';
import {
    availableFeatures,
    FEATURE_CATEGORIES,
    FEATURE_CATEGORY_ICON,
    FEATURE_CATEGORY_LABEL,
    type FeatureCategory
} from '../catalog';
import { FeatureArt, type ArtId } from '../art';
import { ShortcutForm } from './ShortcutForm';
import styles from './organize.module.css';

/**
 * Les rayons du marché.
 *
 * `all` d'abord (avec la recherche, c'est le rayon par défaut), puis les
 * appareils, puis les rayons de fonctionnalités portés par le catalogue, puis
 * les deux rayons de **création** — un raccourci se saisit, un dossier se pose
 * vide. Les six du milieu ne sont pas répétés ici : les tenir à deux endroits
 * serait la garantie qu'un futur rayon n'arrive que dans l'un des deux.
 */
type Rayon = 'all' | 'devices' | FeatureCategory | 'shortcut';

const RAYON_LABEL: Record<'all' | 'devices' | 'shortcut', string> = {
    all: 'Tout',
    devices: 'Appareils',
    shortcut: 'Raccourcis'
};

const RAYON_ICON: Record<'all' | 'devices' | 'shortcut', string> = {
    all: 'list',
    devices: 'server',
    shortcut: 'move-to-right'
};

/**
 * Le rail, en trois groupes séparés d'un filet.
 *
 * L'étal complet ; puis ce qui vient de **vous** — vos machines, vos liens ; puis
 * les fonctionnalités de DevEye, rangées par usage. Sans ces deux filets, dix
 * entrées de même poids se lisaient comme une liste plate où « Appareils » et
 * « Sécurité » semblaient de même nature, alors que l'un désigne votre matériel
 * et l'autre un rayon du catalogue.
 */
const RAIL_GROUPS: Rayon[][] = [['all'], ['devices', 'shortcut'], [...FEATURE_CATEGORIES]];

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
    title: string;
    description: string;
    /** Mots supplémentaires que la recherche doit trouver (plateforme d'un appareil…). */
    keywords?: string;
    /** Élément posé à droite du titre (la pastille d'état d'un appareil). */
    badge?: ReactNode;
    /**
     * Déjà sur l'accueil.
     *
     * La carte **reste à l'étal**, éteinte, au lieu d'en disparaître : un
     * catalogue dont les articles s'effacent au fur et à mesure ne dit plus ce
     * qui existe, et ne laisse pas voir qu'on possède déjà ce qu'on cherchait.
     * Elle n'est simplement plus cliquable, et une seule tuile par
     * fonctionnalité ou par appareil reste la règle.
     */
    placed?: boolean;
    onPick: () => void;
}

/**
 * Le repère du coin d'une carte : ce qu'on peut y faire, ou ce qui est déjà fait.
 *
 * Dessiné ici plutôt que pris dans `Styles/icons.css` : `icon-plus` y pointe sur
 * un glyphe très gras (une croix tracée dans un carré de 309 unités, ramenée à
 * treize pixels), qui à cette taille rend un pâté plutôt qu'un signe. Deux
 * traits arrondis et une coche, dans le même langage que les vignettes juste
 * au-dessus, tiennent en quelques lignes et se règlent au pixel près.
 *
 * La pastille porte la couleur, pas le glyphe : un signe gris perdu dans un coin
 * ne dit pas qu'il y a un geste à faire, un jeton teinté si. Le plein se remplit
 * au survol de la carte, et l'état « déjà posée » passe au vert de succès.
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

/**
 * Le marché : **une seule popup pour tout ce qui se pose sur l'accueil**.
 *
 * Il y avait auparavant trois sélecteurs, atteints par trois boutons différents,
 * parce qu'une section ne tenait qu'un genre de tuile. Les sections étant
 * unifiées, la question « quel genre ? » n'a plus lieu d'être posée à l'avance :
 * on ouvre l'étal, on cherche, on prend. Les rayons ne sont plus qu'un rangement.
 *
 * Un rayon ne présente pas un catalogue mais un **geste de création** : un
 * raccourci se saisit, formulaire complet et aperçu en direct. Il vit au même
 * endroit que le reste parce que, vu de l'accueil, c'en est une carte comme une
 * autre. Les dossiers, eux, ne passent pas par ici : un dossier ne se remplit
 * qu'en y tirant des cartes déjà posées, donc son bouton est au bout de la
 * section, là où se trouvent justement ces cartes.
 *
 * Chaque ajout referme, comme partout ailleurs dans l'application. Seul le
 * formulaire de raccourci fait exception à la règle de fermeture immédiate quand
 * il sert à **éditer** : il se ferme aussi, mais après enregistrement.
 */
export function AddTileMarket({ section, editShortcut, onClose }: AddTileMarketProps) {
    const layout = useHomeLayout();
    const { devices } = useDevices();
    const { user } = useAuth();
    const workspace = useActiveWorkspace();
    const [rayon, setRayon] = useState<Rayon>('all');
    const [query, setQuery] = useState('');

    const open = section !== null;
    const sectionId = section?.id ?? null;

    // Une réouverture repart de l'étal complet : garder le rayon et la recherche
    // du passage précédent ferait s'ouvrir une popup déjà filtrée sans que rien
    // ne l'ait demandé.
    useEffect(() => {
        if (!open) return;
        setRayon('all');
        setQuery('');
    }, [open]);

    /**
     * L'étal, reconstruit à chaque rendu.
     *
     * Volontairement non mémorisé : il dépend de la disposition, de la liste
     * d'appareils, du contexte **et** des rappels du parent, donc une mémo
     * aurait porté une liste de dépendances plus longue que le calcul qu'elle
     * évite — pour une quarantaine d'articles.
     */
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

        // Un widget qu'on n'a pas le droit d'ouvrir ici n'est **pas** proposé,
        // pas même éteint : le montrer reviendrait à annoncer une tuile que la
        // grille refuserait ensuite de rendre. « Déjà posée » et « pas pour
        // vous » sont deux choses différentes, et une seule des deux se montre.
        const placedFeatures = new Set<string>(placedFeatureIds(layout));
        for (const feature of availableFeatures({ kind: workspace?.kind, isAdmin: user?.role === 'admin' })) {
            items.push({
                key: `feature:${feature.id}`,
                rayon: feature.category,
                icon: feature.icon,
                art: feature.id,
                title: feature.title,
                description: feature.description,
                placed: placedFeatures.has(feature.id),
                onPick: () => {
                    addFeature(sectionId, feature.id);
                    onClose();
                }
            });
        }

        // Le rayon des raccourcis n'a pas d'article : c'est un formulaire. Il est
        // pourtant annoncé dans l'étal, sans quoi rien n'y mènerait depuis
        // « Tout » — et c'est là qu'on arrive.
        items.push({
            key: 'shortcut',
            rayon: 'shortcut',
            icon: 'move-to-right',
            art: 'shortcut',
            title: 'Créer un raccourci',
            description: 'Un lien épinglé, avec son aperçu récupéré automatiquement.',
            keywords: 'lien url site favori raccourci',
            // La recherche est vidée avec : elle prend le pas sur le rayon dans
            // l'affichage, donc la laisser garderait la liste de résultats à
            // l'écran et le clic n'aurait rien fait de visible.
            onPick: () => {
                setQuery('');
                setRayon('shortcut');
            }
        });
    }

    const search = query.trim().toLowerCase();

    /**
     * Ce que l'étal montre.
     *
     * Une recherche **traverse les rayons** : chercher « git » depuis le rayon
     * des appareils doit trouver la fonctionnalité, sinon la recherche ne serait
     * qu'un filtre de plus au lieu d'un raccourci. Le rayon ne reprend la main
     * que le champ vide.
     */
    const shown = search
        ? items.filter((item) =>
              `${item.title} ${item.description} ${item.keywords ?? ''}`.toLowerCase().includes(search)
          )
        : rayon === 'all'
          ? items
          : items.filter((item) => item.rayon === rayon);

    /** Combien d'articles par rayon, posés ou non : c'est un inventaire, pas un stock. */
    const counts = new Map<Rayon, number>();
    for (const item of items) counts.set(item.rayon, (counts.get(item.rayon) ?? 0) + 1);
    counts.set('all', items.length);

    // Le rayon des raccourcis montre son formulaire, pas des cartes — sauf
    // pendant une recherche, qui traverse tout et reprend la main sur l'affichage.
    const showShortcutForm = !search && rayon === 'shortcut';

    const editing = editShortcut != null && section !== null;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={editing ? 'Modifier le raccourci' : "Ajouter à l'accueil"}
            width={editing ? 520 : 860}
        >
            {section !== null &&
                (editing ? (
                    <ShortcutForm sectionId={section.id} initial={editShortcut} onDone={onClose} />
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
                                {RAIL_GROUPS.flatMap((group, groupIndex) => [
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
                                        {search ? 'Rien ne correspond à cette recherche.' : 'Aucun appareil connecté.'}
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
                                                <FeatureArt id={item.art} className={styles.marketCardArt} />
                                                <span className={styles.marketCardBody}>
                                                    <span className={styles.marketCardHead}>
                                                        <span
                                                            className={`icon icon-${item.icon} ${styles.marketCardIcon}`}
                                                        />
                                                        <span className={styles.marketCardTitle}>{item.title}</span>
                                                        {item.badge}
                                                        <MarketMark placed={item.placed === true} />
                                                    </span>
                                                    {/* Le rayon n'est rappelé que quand l'étal les mélange :
                                                    dans un rayon donné, le répéter à chaque carte serait
                                                    une colonne de texte identique. */}
                                                    {item.placed ? (
                                                        <span className={styles.marketCardRayon}>
                                                            Déjà sur l’accueil
                                                        </span>
                                                    ) : (
                                                        (search || rayon === 'all') && (
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
