import { memo, type MouseEvent } from 'react';
import type { HomeFolder, HomeTile, ShortcutItem } from '@deveye/types';

import { Widget } from '@/Components/Widget';
import { catalogEntries } from '../catalog';
import { isForceReload } from '../forceReload';
import styles from '../Dashboard.module.css';
import { deviceTileVisual, featureTileVisual, shortcutTileVisual } from './tileVisual';

/**
 * Les cartes de la grille, une par genre de tuile, mémoïsées.
 *
 * Le corps d'une tuile est un élément recréé à chaque appel de `featureTileVisual`
 * et consorts : rendues depuis le corps de l'accueil, les tuiles reprenaient donc
 * toutes leur rendu au moindre changement d'état, si étranger fût-il, et
 * framer-motion reprojetait le layout de chacune. Chaque genre calcule ici son
 * propre visuel, à partir de props stables.
 *
 * Les gestionnaires reçus doivent l'être aussi : côté accueil, ils passent par
 * une référence plutôt que par les dépendances d'un `useCallback`.
 */

type ExpandHandler = (widgetId: string, e: MouseEvent<HTMLDivElement>) => void;

interface CardBase {
    /** La vue de cette tuile est ouverte : la carte source s'efface derrière le morphe. */
    hidden?: boolean;
}

/** Rien à cacher n'est pas la même chose qu'un style vide : framer fusionne les deux. */
const HIDDEN_STYLE = { opacity: 0 } as const;

export const FolderTileCard = memo(function FolderTileCard({
    folder,
    onOpen
}: {
    folder: HomeFolder;
    onOpen: (folderId: string, e: MouseEvent<HTMLDivElement>) => void;
}) {
    const v = featureTileVisual(folder);
    if (!v) return null;
    return (
        <Widget
            widgetId={v.widgetId}
            title={v.title}
            icon={v.icon}
            interactive={catalogEntries(folder.items).length > 0}
            // La tuile reste visible pendant le déploiement : elle part avec le
            // fond qui recule et dit d'où viennent les cartes.
            onExpand={(e) => onOpen(folder.id, e)}
        >
            {v.body}
        </Widget>
    );
});

export const ShortcutTileCard = memo(function ShortcutTileCard({ item }: { item: ShortcutItem }) {
    const v = shortcutTileVisual(item);
    return (
        <Widget widgetId={v.widgetId} compact={v.compact} href={v.href}>
            {v.body}
        </Widget>
    );
});

export const FeatureTileCard = memo(function FeatureTileCard({
    tile,
    locked,
    hidden,
    onExpand
}: CardBase & {
    tile: HomeTile;
    /** Le rôle n'ouvre pas cette vue : la carte reste posée, en retrait. */
    locked?: boolean;
    onExpand: ExpandHandler;
}) {
    const v = featureTileVisual(tile);
    if (!v) return null;
    return (
        <Widget
            widgetId={v.widgetId}
            title={v.title}
            icon={v.icon}
            className={locked ? styles.lockedTile : undefined}
            style={hidden ? HIDDEN_STYLE : undefined}
            onExpand={(e) => onExpand(v.widgetId, e)}
        >
            {/* Le contenu vivant est remplacé, pas seulement grisé : il
                interrogerait un serveur qui refuse, et afficherait des zéros qui
                se lisent comme des données réelles. */}
            {locked ? <span className={styles.lockedBody}>Accès restreint</span> : v.body}
        </Widget>
    );
});

export const DeviceTileCard = memo(function DeviceTileCard({
    deviceId,
    hidden,
    onOpen
}: CardBase & {
    deviceId: string;
    onOpen: (deviceId: string, tileKey: string, forceReset: boolean) => void;
}) {
    const v = deviceTileVisual(deviceId);
    if (!v) return null;
    return (
        <Widget
            widgetId={v.widgetId}
            title={v.title}
            icon={v.icon}
            compact={v.compact}
            style={hidden ? HIDDEN_STYLE : undefined}
            onExpand={(e) => onOpen(deviceId, v.widgetId, isForceReload(e))}
        >
            {v.body}
        </Widget>
    );
});
