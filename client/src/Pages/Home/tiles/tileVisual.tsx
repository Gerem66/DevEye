import type { ReactNode } from 'react';
import type { HomeTile, ShortcutItem } from '@deveye/types';
import { homeTileKind, isFeatureTile, isHomeFolder, isShortcutTile } from '@deveye/types';
import type { SdkDeviceSummary } from '@deveye/types/sdk/client';
import { devicesProvider } from '@/devicesProvider';
import { ShortcutTile } from './ShortcutTile';
import { FolderTile, folderKey, folderTitle } from '../folders';
import { featureCatalogEntry } from '../catalog';

/**
 * Shared definition of a grid tile's visuals, so normal mode (interactive,
 * morphing card) and edit mode (static, sortable card) render exactly the same
 * card chrome + content. The wrapper (morph vs. drag) differs; the inside does not.
 */
export interface TileVisual {
    /** Stable id used for the morph layoutId and the presence outline. */
    widgetId: string;
    title?: string;
    icon?: string;
    /**
     * Carte courte : appareils et raccourcis, à la même hauteur puisqu'une même
     * ligne peut les mêler ; deux cartes courtes de hauteurs différentes se
     * liraient comme un défaut d'alignement.
     */
    compact?: boolean;
    /** When set, the tile is a real link (anchor) opening this URL in a new tab. */
    href?: string;
    body: ReactNode;
}

/** Un appareil n'est pas une vue : sa clé ne sert qu'au morphe et à la présence. */
export const deviceKey = (deviceId: string) => `device:${deviceId}`;
export const shortcutKey = (id: string) => `shortcut:${id}`;

/** La carte d'un widget de fonctionnalité, ou celle d'un dossier. */
export function featureTileVisual(tile: HomeTile): TileVisual | null {
    if (isHomeFolder(tile)) {
        return {
            widgetId: folderKey(tile.id),
            title: folderTitle(tile.title),
            icon: 'folder',
            body: <FolderTile folder={tile} />
        };
    }
    const entry = isFeatureTile(tile) ? featureCatalogEntry(tile) : undefined;
    if (!entry) return null;
    return {
        widgetId: entry.id,
        title: entry.title,
        icon: entry.icon,
        compact: entry.compact,
        body: <entry.WidgetContent />
    };
}

/** La carte d'un appareil, fournie par le provider du module Appareils. `null`
 *  sans le module (la liste est alors vide de toute façon). */
export function deviceTileVisual(device: SdkDeviceSummary, opts?: { editing?: boolean }): TileVisual | null {
    const DeviceWidget = devicesProvider()?.DeviceWidget;
    if (!DeviceWidget) return null;
    // No Widget header — DeviceWidget owns the whole card (name + status + the
    // full-bleed activity background).
    return {
        widgetId: deviceKey(device.id),
        compact: true,
        body: <DeviceWidget deviceId={device.id} hideStatus={opts?.editing} />
    };
}

export function shortcutTileVisual(item: ShortcutItem, opts?: { editing?: boolean }): TileVisual {
    // No header — the shortcut body owns the whole (compact) card, which is a link.
    return {
        widgetId: shortcutKey(item.id),
        compact: true,
        href: item.url,
        body: <ShortcutTile item={item} hideBadge={opts?.editing} />
    };
}

/**
 * La carte d'une tuile, quel que soit son genre : le seul aiguillage de
 * l'accueil. `null` quand la tuile ne désigne plus rien ; l'appelant décide
 * s'il l'escamote ou pose une carte « indisponible ».
 */
export function homeTileVisual(
    tile: HomeTile,
    devices: readonly SdkDeviceSummary[],
    opts?: { editing?: boolean }
): TileVisual | null {
    if (homeTileKind(tile) === 'device') {
        const device = devices.find((d) => d.id === tile);
        return device ? deviceTileVisual(device, opts) : null;
    }
    if (isShortcutTile(tile)) return shortcutTileVisual(tile, opts);
    return featureTileVisual(tile);
}
