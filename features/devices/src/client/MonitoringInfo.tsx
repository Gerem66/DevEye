/** Explainer shown by the Monitoring "i" button (via openInfo). */
export function MonitoringInfo() {
    return (
        <div>
            <p>
                Chaque appareil exécute l&apos;agent DevEye, qui envoie ses mesures au serveur par une connexion
                permanente. Les données restent affichées même quand l&apos;agent est hors ligne : vous voyez les
                dernières valeurs connues, et les débits temps réel passent à 0.
            </p>
            <h4>Une seule cadence de collecte</h4>
            <ul>
                <li>
                    <b>
                        Un relevé (par défaut chaque minute sur une offre payante, toutes les 5 min sur l&apos;offre
                        gratuite)
                    </b>{' '}
                    : chaque tick de l&apos;agent produit un <b>instant</b> — les mesures (CPU, RAM, disque, réseau,
                    charge, température, GPU, utilisateurs, connexions) <i>et</i> la liste des processus, sous un seul
                    et même horodatage. Ce sont les repères cliquables de la frise.
                </li>
                <li>
                    <b>Toutes les heures</b> : l&apos;état de sécurité (pare-feu, chiffrement, SIP, mises à jour), les{' '}
                    <b>ports en écoute</b>, le niveau de privilèges de l&apos;agent et l&apos;
                    <b>inventaire matériel</b> (CPU, RAM, GPU, réseau, Bluetooth, disques).
                </li>
                <li>
                    <b>Bouton rafraîchir</b> : demande à l&apos;agent un relevé immédiat, intégré à l&apos;historique à
                    son horodatage réel.
                </li>
            </ul>
            <p>
                Ces réglages (intervalle, processus capturés : <i>tous / top 20 / désactivé</i>, durée de conservation)
                se règlent <b>par appareil</b> depuis l&apos;icône <span className='icon icon-settings' /> de ce
                panneau, et sont appliqués en direct. La conservation est <b>unique</b> : mesures, présence et processus
                d&apos;un même instant expirent ensemble. Au-delà de deux jours, un relevé ne garde que ses{' '}
                <b>20 processus les plus actifs</b> (CPU et mémoire), sauf s&apos;il est épinglé. L&apos;icône{' '}
                <span className='icon icon-cpu' /> ouvre la fiche <b>Matériel &amp; agent</b> : détail complet du
                matériel de la machine (CPU, RAM, GPU, réseau, Bluetooth, disques) et identité de l&apos;agent.
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
                <li>
                    <b>Conserver</b> : épingle un instant (ou une zone) pour le garder au-delà de la durée de
                    conservation habituelle — ses repères passent en doré sur la frise. « Ne plus conserver » lève le
                    verrou : l&apos;instant expirera de nouveau (supprimé aussitôt s&apos;il a déjà dépassé sa date
                    limite).
                </li>
            </ul>
            <h4>Processus & CPU</h4>
            <p>
                Le mode de capture (<i>tous / top 20 / désactivé</i>) décide combien de processus sont historisés à
                chaque relevé. En mode <i>tous</i>, ils sont agrégés <b>par nom de programme</b> (les apps multi-process
                comptent comme une). Le CPU affiché est rapporté au nombre de cœurs (0–100 % = machine entière) ; la
                valeur Unix brute, cumulée sur tous les cœurs, peut dépasser 100 % (survolez pour la voir).
            </p>
            <h4>Sécurité & privilèges</h4>
            <p>
                Les sondes de sécurité sont en « best-effort » : si l&apos;outil système n&apos;est pas disponible, la
                valeur est « Inconnu ». Certaines mesures dépendent des droits de l&apos;agent : la pastille{' '}
                <b>Privilèges agent</b> indique s&apos;il tourne en root/élevé et, sinon, ce que cela limite et comment
                le relancer avec privilèges. D&apos;autres mesures sont indisponibles selon la plateforme (ex.
                température et GPU sur Apple Silicon, E/S disque sur macOS).
            </p>
        </div>
    );
}
