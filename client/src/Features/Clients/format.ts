import type { BadgeTone } from '@/Components/StatusBadge';
import type { DeviceStatus } from 'deveye-types';

/** Localized lifecycle label + badge tone for a device status. */
export function statusMeta(status: DeviceStatus): { label: string; tone: BadgeTone } {
    switch (status) {
        case 'pending':
            return { label: 'En attente', tone: 'warning' };
        case 'active':
            return { label: 'Approuvé', tone: 'success' };
        case 'revoked':
            return { label: 'Révoqué', tone: 'danger' };
        case 'pending_deletion':
            return { label: 'Suppression en attente', tone: 'warning' };
        case 'archived':
            return { label: 'Archivé', tone: 'neutral' };
    }
}

/** Human-readable validity for a link code (`null` = never expires). */
export function formatExpiry(expiresAt: number | null): string {
    if (expiresAt === null) return 'N’expire pas';
    const secs = expiresAt - Math.floor(Date.now() / 1000);
    if (secs <= 0) return 'Expiré';
    const mins = Math.ceil(secs / 60);
    if (mins < 60) return `Expire dans ${mins} min`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `Expire dans ${hours} h`;
    return `Expire le ${new Date(expiresAt * 1000).toLocaleDateString('fr-FR')}`;
}

/** Relative "last seen" label; `null` → never. */
export function formatLastSeen(ts: number | null): string {
    if (ts === null) return 'Jamais';
    // `lastSeen` is stored in seconds; bring it to ms before diffing.
    const diffMs = Date.now() - ts * 1000;
    const minutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (minutes < 1) return "À l'instant";
    if (minutes < 60) return `Il y a ${minutes} min`;
    if (hours < 24) return `Il y a ${hours}h`;
    return `Il y a ${days}j`;
}
