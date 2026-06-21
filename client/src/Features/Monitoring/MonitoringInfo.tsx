/** Explainer shown by the Monitoring "i" button (via openInfo). */
export function MonitoringInfo() {
    return (
        <div>
            <p>
                Chaque appareil exécute l&apos;agent DevEye, qui envoie ses mesures au serveur par une connexion
                permanente. Les données restent affichées même quand l&apos;agent est hors ligne : vous voyez les
                dernières valeurs connues, et les débits temps réel passent à 0.
            </p>
            <h4>Deux cadences de collecte</h4>
            <ul>
                <li>
                    <b>Métriques (~10 s)</b> : un relevé léger (CPU, RAM, disque, réseau, charge, température, GPU,
                    utilisateurs, connexions) qui alimente les graphes en haute résolution.
                </li>
                <li>
                    <b>Snapshots (~5 min)</b> : la liste des processus (selon le mode choisi) ainsi que le nombre de
                    processus et les E/S disque. Ce sont les repères cliquables de la frise.
                </li>
                <li>
                    <b>Toutes les heures</b> : l&apos;état de sécurité (pare-feu, chiffrement, SIP, mises à jour).
                </li>
                <li>
                    <b>Bouton rafraîchir</b> : demande à l&apos;agent un relevé immédiat, intégré à l&apos;historique à
                    son horodatage réel.
                </li>
            </ul>
            <p>
                Ces réglages (intervalles, processus capturés : <i>tous / top 20 / désactivé</i>, durées de
                conservation) se règlent <b>par appareil</b> depuis l&apos;icône <span className='icon icon-settings' />{' '}
                de ce panneau, et sont appliqués en direct.
            </p>
            <h4>Remonter le temps</h4>
            <p>La frise montre les périodes en ligne/hors ligne. Choisissez un jour avec les flèches, puis :</p>
            <ul>
                <li>
                    <b>Cliquez un repère</b> (ou un instant) : les KPI et processus affichés sont ceux capturés à cet
                    instant précis, et les graphes zooment sur l&apos;intervalle correspondant.
                </li>
                <li>
                    <b>Glissez une zone</b> : les graphes couvrent la période et les KPI deviennent des moyennes ; les
                    processus correspondent à la fin de la sélection.
                </li>
                <li>
                    <b>Direct</b> : revient au suivi temps réel.
                </li>
            </ul>
            <h4>Sécurité & confidentialité</h4>
            <p>
                Les sondes de sécurité sont en « best-effort » : si l&apos;outil système n&apos;est pas disponible, la
                valeur est « Inconnu ». Certaines mesures sont indisponibles selon la plateforme (ex. température et GPU
                sur Apple Silicon sans privilèges, E/S disque sur macOS).
            </p>
        </div>
    );
}
