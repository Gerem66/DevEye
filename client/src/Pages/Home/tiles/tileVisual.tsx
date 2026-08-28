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
    /** Stable id used for the morph layoutId / popup view id. */
    widgetId: string;
    title?: string;
    icon?: string;
    /**
     * Carte courte : appareils et raccourcis.
     *
     * **La même hauteur pour les deux**, et c'est le point : les deux genres
     * cohabitent désormais dans une même section, donc une même ligne peut les
     * mêler. Deux cartes courtes de hauteurs différentes côte à côte se lisaient
     * comme un défaut d'alignement. Une carte de fonctionnalité, elle, reste
     * haute : mêler les hauteurs sur une ligne est assumé, mêler deux hauteurs
     * *presque* égales ne l'est pas.
     */
    compact?: boolean;
    /** When set, the tile is a real link (anchor) opening this URL in a new tab. */
    href?: string;
    body: ReactNode;
}

export const DEVICE_VIEW_PREFIX = 'device:';
export const deviceViewId = (deviceId: string) => `${DEVICE_VIEW_PREFIX}${deviceId}`;
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

/**
 * La carte d'un appareil : celle que le module Appareils fournit par son
 * provider. `null` sans le module, mais on n'y arrive pas : sans lui, la
 * liste d'appareils est vide et aucune tuile d'appareil ne se rend.
 */
export function deviceTileVisual(device: SdkDeviceSummary, opts?: { editing?: boolean }): TileVisual | null {
    const DeviceWidget = devicesProvider()?.DeviceWidget;
    if (!DeviceWidget) return null;
    // No Widget header — DeviceWidget owns the whole card (name + status + the
    // full-bleed activity background).
    return {
        widgetId: deviceViewId(device.id),
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
 * La carte d'une tuile, quel que soit son genre.
 *
 * Le seul aiguillage de l'accueil : la grille et l'organiseur passent par lui,
 * donc une section n'a jamais à savoir ce qu'elle tient. Rend `null` quand la
 * tuile ne désigne plus rien (appareil supprimé, identifiant écrit par une
 * version plus récente) ; l'appelant décide alors s'il l'escamote ou s'il pose
 * une carte « indisponible ».
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
