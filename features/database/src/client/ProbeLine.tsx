import { useEffect, useState } from 'react';
import type { DatabaseProbe } from '../contracts/domain';
import styles from './style.module.css';

/** Le résultat d'un essai s'efface après ce délai. */
const KEEP_MS = 10_000;

interface ProbeLineProps {
    testing: boolean;
    probe: DatabaseProbe | null;
}

/**
 * Ce qu'a donné « Tester » : une attente pendant l'essai (un tunnel prend des
 * secondes), puis un résultat qui s'efface seul, sa réponse ne valant que pour
 * l'instant où on l'a posée. « Relever » écrit dans le bandeau d'état, pas ici.
 */
export function ProbeLine({ testing, probe }: ProbeLineProps) {
    const [shown, setShown] = useState<DatabaseProbe | null>(null);

    useEffect(() => {
        setShown(probe);
        if (probe === null) return;
        const timer = setTimeout(() => setShown(null), KEEP_MS);
        return () => clearTimeout(timer);
    }, [probe]);

    // L'attente prime sur un résultat encore affiché.
    if (testing) return <p className={styles.pending}>Connexion en cours…</p>;
    if (!shown) return null;

    return (
        <p className={shown.ok ? styles.ok : styles.error}>
            {shown.ok
                ? `Connexion réussie en ${shown.elapsedMs} ms · ${shown.serverVersion}`
                : `Connexion impossible : ${shown.error}`}
        </p>
    );
}

export default ProbeLine;
