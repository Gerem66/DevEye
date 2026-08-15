import type { ReactNode } from 'react';
import type { Device, HomeFeatureTile, ShortcutItem } from 'deveye-types';
import { isHomeFolder } from 'deveye-types';
import { DeviceWidget } from '@/Features/Monitoring/DeviceWidget';
import { ShortcutTile } from './ShortcutTile';
import { FolderTile, folderKey, folderTitle } from '../folders';
import { featureCatalogEntry } from '../catalog';

/**
 * Shared definition of a grid tile's visuals, so normal mode (interactive,
 * morphing card) and edit mode (static, sortable card) render exactly the same
 * card chrome + content. The wrapper (morph vs. drag) differs; the inside does not.
 */
export interface TileVisual {
    /** Stable id used for the morph layoutId / popup view id. */
    widgetId: string;
    title?: string;
    icon?: string;
    /** Shorter card (device tiles). */
    compact?: boolean;
    /** Even shorter "thin & long" card (shortcut tiles). */
    slim?: boolean;
    /** When set, the tile is a real link (anchor) opening this URL in a new tab. */
    href?: string;
    body: ReactNode;
}

export const DEVICE_VIEW_PREFIX = 'device:';
export const deviceViewId = (deviceId: string) => `${DEVICE_VIEW_PREFIX}${deviceId}`;
export const shortcutKey = (id: string) => `shortcut:${id}`;

/**
 * La tuile d'une section de fonctionnalités : la carte d'un widget, ou celle
 * d'un dossier. Les deux se rendent pareil, à la grille comme à l'organiseur,
 * parce que sur l'accueil ce sont deux tuiles comme les autres.
 */
export function featureTileVisual(tile: HomeFeatureTile): TileVisual | null {
    if (isHomeFolder(tile)) {
        return {
            widgetId: folderKey(tile.id),
            title: folderTitle(tile.title),
            icon: 'folder',
            body: <FolderTile folder={tile} />
        };
    }
    const entry = featureCatalogEntry(tile);
    if (!entry) return null;
    return { widgetId: entry.id, title: entry.title, icon: entry.icon, body: <entry.WidgetContent /> };
}

export function deviceTileVisual(device: Device, opts?: { editing?: boolean }): TileVisual {
    // No Widget header — DeviceWidget owns the whole card (name + status + the
    // full-bleed activity background).
    return {
        widgetId: deviceViewId(device.id),
        compact: true,
        body: <DeviceWidget deviceId={device.id} hideStatus={opts?.editing} />
    };
}

export function shortcutTileVisual(item: ShortcutItem, opts?: { editing?: boolean }): TileVisual {
    // No header — the shortcut body owns the whole (slim) card, which is a link.
    return {
        widgetId: shortcutKey(item.id),
        slim: true,
        href: item.url,
        body: <ShortcutTile item={item} hideBadge={opts?.editing} />
    };
}
