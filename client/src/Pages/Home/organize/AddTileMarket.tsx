import { useEffect, useState, type ReactNode } from 'react';
import type { HomeSection, ShortcutItem } from 'deveye-types';

import { Dialog } from '@/Components/Dialog';
import TextInput from '@/Components/TextInput';
import { useAuth } from '@/auth/AuthProvider';
import { useDevices } from '@/stores/devices';
import { useActiveWorkspace } from '@/stores/workspace';
import {
    addDevice,
    addFeature,
    addFolder,
    placedDeviceIds,
    placedFeatureIds,
    useHomeLayout
} from '@/stores/homeLayout';
import {
    availableFeatures,
    FEATURE_CATEGORIES,
    FEATURE_CATEGORY_ICON,
    FEATURE_CATEGORY_LABEL,
    type FeatureCategory
} from '../catalog';
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
type Rayon = 'all' | 'devices' | FeatureCategory | 'shortcut' | 'folder';

const RAYON_LABEL: Record<'all' | 'devices' | 'shortcut' | 'folder', string> = {
    all: 'Tout',
    devices: 'Appareils',
    shortcut: 'Raccourcis',
    folder: 'Dossiers'
};

const RAYON_ICON: Record<'all' | 'devices' | 'shortcut' | 'folder', string> = {
    all: 'list',
    devices: 'server',
    shortcut: 'move-to-right',
    folder: 'folder'
};

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
    title: string;
    description: string;
    /** Mots supplémentaires que la recherche doit trouver (plateforme d'un appareil…). */
    keywords?: string;
    /** Élément posé à droite du titre (la pastille d'état d'un appareil). */
    badge?: ReactNode;
    onPick: () => void;
}

export interface AddTileMarketProps {
    /** Section à garnir, ou `null` quand le marché est fermé. */
    section: HomeSection | null;
    /** Quand renseigné, la popup édite ce raccourci au lieu d'ouvrir le marché. */
    editShortcut?: ShortcutItem | null;
    onClose: () => void;
    /** Un dossier vient d'être posé : l'organiseur ouvre sa fiche dans la foulée. */
    onFolderAdded: (folderId: string) => void;
}

/**
 * Le marché : **une seule popup pour tout ce qui se pose sur l'accueil**.
 *
 * Il y avait auparavant trois sélecteurs, atteints par trois boutons différents,
 * parce qu'une section ne tenait qu'un genre de tuile. Les sections étant
 * unifiées, la question « quel genre ? » n'a plus lieu d'être posée à l'avance :
 * on ouvre l'étal, on cherche, on prend. Les rayons ne sont plus qu'un rangement.
 *
 * Deux rayons ne présentent pas un catalogue mais un **geste de création** : un
 * raccourci se saisit (formulaire complet, avec son aperçu en direct), un
 * dossier se pose vide et s'ouvre aussitôt pour être rempli. Ils vivent au même
 * endroit que le reste parce que, vu de l'accueil, ce sont des tuiles comme les
 * autres.
 *
 * Chaque ajout referme, comme partout ailleurs dans l'application. Seul le
 * formulaire de raccourci fait exception à la règle de fermeture immédiate quand
 * il sert à **éditer** : il se ferme aussi, mais après enregistrement.
 */
export function AddTileMarket({ section, editShortcut, onClose, onFolderAdded }: AddTileMarketProps) {
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
            if (device.status === 'archived' || placedDevices.has(device.id)) continue;
            items.push({
                key: `device:${device.id}`,
                rayon: 'devices',
                icon: 'server',
                title: device.name,
                description: device.online ? 'En ligne' : 'Hors ligne',
                keywords: device.platform,
                badge: <span className={`${styles.addDot} ${device.online ? styles.online : styles.offline}`} />,
                onPick: () => {
                    addDevice(sectionId, device.id);
                    onClose();
                }
            });
        }

        // Un widget qu'on n'a pas le droit d'ouvrir ici n'est pas non plus
        // *proposé* : le montrer reviendrait à laisser poser une tuile que la
        // grille refuserait ensuite de rendre. Une fonctionnalité déjà posée
        // (dossiers compris) disparaît de l'étal pour la même raison.
        const placedFeatures = new Set<string>(placedFeatureIds(layout));
        for (const feature of availableFeatures({ kind: workspace?.kind, isAdmin: user?.role === 'admin' })) {
            if (placedFeatures.has(feature.id)) continue;
            items.push({
                key: `feature:${feature.id}`,
                rayon: feature.category,
                icon: feature.icon,
                title: feature.title,
                description: feature.description,
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

        items.push({
            key: 'folder',
            rayon: 'folder',
            icon: 'folder-plus',
            title: 'Nouveau dossier',
            description: 'Range plusieurs fonctionnalités derrière une seule tuile.',
            keywords: 'dossier rangement groupe',
            onPick: () => {
                const id = addFolder(sectionId);
                onClose();
                if (id) onFolderAdded(id);
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

    /** Combien d'articles par rayon, pour que le rail dise où il reste à prendre. */
    const counts = new Map<Rayon, number>();
    for (const item of items) counts.set(item.rayon, (counts.get(item.rayon) ?? 0) + 1);
    counts.set('all', items.length);

    const rails: Rayon[] = ['all', 'devices', ...FEATURE_CATEGORIES, 'shortcut', 'folder'];
    // Le rayon des raccourcis montre son formulaire, pas des cartes — sauf
    // pendant une recherche, qui traverse tout et reprend la main sur l'affichage.
    const showShortcutForm = !search && rayon === 'shortcut';

    const editing = editShortcut != null && section !== null;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={editing ? 'Modifier le raccourci' : "Ajouter à l'accueil"}
            width={editing ? 520 : 780}
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
                                {rails.map((id) => {
                                    // Les deux rayons de création ne comptent rien : « 1 » en
                                    // face de « Raccourcis » se lirait comme un stock restant.
                                    const count = id === 'shortcut' || id === 'folder' ? undefined : counts.get(id);
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
                                            <span className={`icon icon-${rayonIcon(id)} ${styles.marketRailIcon}`} />
                                            <span className={styles.marketRailLabel}>{rayonLabel(id)}</span>
                                            {count !== undefined && (
                                                <span className={styles.marketRailCount}>{count}</span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>

                            <div className={styles.marketPane}>
                                {showShortcutForm ? (
                                    <ShortcutForm sectionId={section.id} onDone={onClose} />
                                ) : shown.length === 0 ? (
                                    <p className={styles.addEmpty}>
                                        {search
                                            ? 'Rien ne correspond à cette recherche.'
                                            : rayon === 'devices'
                                              ? devices.length === 0
                                                  ? 'Aucun appareil connecté.'
                                                  : 'Tous vos appareils sont déjà sur l’accueil.'
                                              : 'Tout ce rayon est déjà sur l’accueil.'}
                                    </p>
                                ) : (
                                    <div className={styles.marketGrid}>
                                        {shown.map((item) => (
                                            <button
                                                key={item.key}
                                                type='button'
                                                className={styles.marketCard}
                                                onClick={item.onPick}
                                            >
                                                <span className={styles.marketCardHead}>
                                                    <span
                                                        className={`icon icon-${item.icon} ${styles.marketCardIcon}`}
                                                    />
                                                    <span className={styles.marketCardTitle}>{item.title}</span>
                                                    {item.badge}
                                                    <span className={`icon icon-plus ${styles.marketCardPlus}`} />
                                                </span>
                                                {/* Le rayon n'est rappelé que quand l'étal les mélange :
                                                    dans un rayon donné, le répéter à chaque carte serait
                                                    une colonne de texte identique. */}
                                                {(search || rayon === 'all') && (
                                                    <span className={styles.marketCardRayon}>
                                                        {rayonLabel(item.rayon)}
                                                    </span>
                                                )}
                                                <span className={styles.marketCardDesc}>{item.description}</span>
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
