/** Human-readable validity for a link code (seven days at most). */
export function formatExpiry(expiresAt: number): string {
    const secs = expiresAt - Math.floor(Date.now() / 1000);
    if (secs <= 0) return 'Expiré';
    const mins = Math.ceil(secs / 60);
    if (mins < 60) return `Expire dans ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `Expire dans ${hours} h`;
    const days = Math.floor(hours / 24);
    return `Expire dans ${days} jour${days > 1 ? 's' : ''}`;
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
