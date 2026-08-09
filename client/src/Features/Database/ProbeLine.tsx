import { useEffect, useState } from 'react';
import type { DatabaseProbe } from 'deveye-types';
import styles from './style.module.css';

/** Combien de temps le résultat d'un essai reste à l'écran. */
const KEEP_MS = 10_000;

interface ProbeLineProps {
    /** Un essai est en cours : on le dit, plutôt que de ne rien montrer. */
    testing: boolean;
    /** Le résultat du dernier essai, ou `null` s'il n'y en a pas eu. */
    probe: DatabaseProbe | null;
}

/**
 * Ce qu'a donné « Tester », et rien d'autre.
 *
 * Trois raisons d'être, toutes tirées de l'usage :
 *
 *  - **pendant** l'essai, une ligne d'attente. Joindre une base derrière un
 *    tunnel prend parfois plusieurs secondes : sans elle, un bouton grisé était
 *    le seul signe que quelque chose partait, et l'on cliquait de nouveau ;
 *  - **après**, le résultat s'efface tout seul au bout de dix secondes. C'est un
 *    « est-ce que ça répond ? » : sa réponse vaut pour l'instant où on l'a posée,
 *    et la laisser à l'écran la ferait passer pour un état courant une heure plus
 *    tard ;
 *  - **seulement pour les essais**. « Relever l'état » écrit son résultat dans le
 *    bandeau juste en dessous — le redire ici en doublerait la lecture.
 *
 * Le compte à rebours repart à chaque nouveau résultat, l'objet `probe` étant
 * remplacé à chaque essai.
 */
export function ProbeLine({ testing, probe }: ProbeLineProps) {
    const [shown, setShown] = useState<DatabaseProbe | null>(null);

    useEffect(() => {
        setShown(probe);
        if (probe === null) return;
        const timer = setTimeout(() => setShown(null), KEEP_MS);
        return () => clearTimeout(timer);
    }, [probe]);

    // L'attente prime : un essai relancé pendant qu'un résultat est encore
    // affiché montre « en cours », pas le résultat périmé de l'essai précédent.
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
