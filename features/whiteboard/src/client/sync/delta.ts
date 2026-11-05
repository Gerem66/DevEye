/** Ce que la fusion lit d'un élément de scène. */
export interface Versioned {
    id: string;
    version: number;
}

/**
 * Ce que le serveur tient de chaque élément, vu d'ici : la version envoyée ou
 * reçue la plus haute. Un élément part quand sa version locale la dépasse, et
 * jamais deux fois pour la même version tant qu'un envoi est en route.
 */
export class DeltaTracker {
    private known = new Map<string, number>();
    private inflight = new Map<string, number>();

    /** Les éléments plus récents ici que là-bas, `max` au plus. */
    diff<T extends Versioned>(elements: readonly T[], max: number): T[] {
        const out: T[] = [];
        for (const el of elements) {
            const seen = Math.max(this.known.get(el.id) ?? 0, this.inflight.get(el.id) ?? 0);
            if (el.version <= seen) continue;
            out.push(el);
            if (out.length >= max) break;
        }
        return out;
    }

    sending(elements: readonly Versioned[]): void {
        for (const el of elements) this.inflight.set(el.id, el.version);
    }

    /** L'envoi a abouti (accepté ou écarté) : ces versions ne repartent plus. */
    sent(elements: readonly Versioned[]): void {
        for (const el of elements) {
            this.inflight.delete(el.id);
            this.bump(el);
        }
    }

    /** L'envoi a échoué : ces éléments repartiront au prochain calcul. */
    failed(elements: readonly Versioned[]): void {
        for (const el of elements) this.inflight.delete(el.id);
    }

    received(elements: readonly Versioned[]): void {
        for (const el of elements) this.bump(el);
    }

    /** Ce que le serveur a renvoyé en entier (une entrée dans la séance) devient la référence. */
    reset(elements: readonly Versioned[]): void {
        this.known = new Map(elements.map((el) => [el.id, el.version]));
        this.inflight.clear();
    }

    private bump(el: Versioned): void {
        if (el.version > (this.known.get(el.id) ?? 0)) this.known.set(el.id, el.version);
    }
}
