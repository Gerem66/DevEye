import { useEffect, useRef, useState } from 'react';

/** Fenêtre de la moyenne glissante du débit. */
const WINDOW_MS = 8_000;

interface Sample {
    at: number;
    bytes: number;
}

/**
 * Débit et temps restant d'un transfert, lissés.
 *
 * La moyenne glissante n'est pas un raffinement : `bytesDone` arrive par frames
 * throttlées et irrégulières, donc un débit instantané (delta ÷ delta) saute de
 * 0 à des centaines de Mo/s d'une image à l'autre et rend l'estimation
 * inutilisable. On garde donc quelques secondes d'historique.
 *
 * Renvoie `null` tant qu'il n'y a pas de quoi estimer honnêtement — mieux vaut
 * ne rien afficher qu'un chiffre inventé.
 */
export function useTransferRate(bytesDone: number, bytesTotal: number) {
    const samples = useRef<Sample[]>([]);
    const [rate, setRate] = useState<number | null>(null);

    useEffect(() => {
        const now = Date.now();
        const history = samples.current;
        // Un compteur qui recule = nouvelle session : l'historique n'a plus de sens.
        if (history.length > 0 && bytesDone < history[history.length - 1].bytes) history.length = 0;
        history.push({ at: now, bytes: bytesDone });
        while (history.length > 1 && now - history[0].at > WINDOW_MS) history.shift();

        const first = history[0];
        const elapsed = (now - first.at) / 1000;
        setRate(elapsed >= 1 && bytesDone > first.bytes ? (bytesDone - first.bytes) / elapsed : null);
    }, [bytesDone]);

    const remaining = bytesTotal - bytesDone;
    const etaSeconds = rate !== null && rate > 0 && remaining > 0 ? Math.round(remaining / rate) : null;
    return { rate, etaSeconds };
}

/** « 2 min 05 s », « 45 s » — jamais de décimales, jamais d'heures parasites. */
export function formatEta(seconds: number): string {
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
