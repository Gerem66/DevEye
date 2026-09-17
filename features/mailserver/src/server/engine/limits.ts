/** Les bornes par adresse IP des écouteurs SMTP : connexions simultanées, et connexions par minute. */
export class IpLimiter {
    private readonly open = new Map<string, number>();
    private readonly recent = new Map<string, number[]>();

    constructor(
        private readonly maxOpen: number,
        private readonly maxPerMinute: number
    ) {}

    /** Prend une place pour cette adresse, ou refuse. Toute place prise se rend par `release`. */
    admit(ip: string, nowMs: number): boolean {
        const hits = (this.recent.get(ip) ?? []).filter((ts) => ts > nowMs - 60_000);
        if (hits.length >= this.maxPerMinute || (this.open.get(ip) ?? 0) >= this.maxOpen) {
            this.recent.set(ip, hits);
            return false;
        }
        hits.push(nowMs);
        this.recent.set(ip, hits);
        this.open.set(ip, (this.open.get(ip) ?? 0) + 1);
        return true;
    }

    release(ip: string): void {
        const left = (this.open.get(ip) ?? 1) - 1;
        if (left <= 0) this.open.delete(ip);
        else this.open.set(ip, left);
    }
}

/** Un compteur à fenêtre glissante par clé : les envois d'une boîte sur une heure. */
export class SlidingCounter {
    private readonly hits = new Map<number, number[]>();

    constructor(private readonly windowMs: number) {}

    count(key: number, nowMs: number): number {
        const kept = (this.hits.get(key) ?? []).filter((ts) => ts > nowMs - this.windowMs);
        this.hits.set(key, kept);
        return kept.length;
    }

    add(key: number, nowMs: number, times = 1): void {
        const kept = this.hits.get(key) ?? [];
        for (let i = 0; i < times; i += 1) kept.push(nowMs);
        this.hits.set(key, kept);
    }
}
