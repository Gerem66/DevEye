/** Explainer shown by the pairing dialog "i" button (via openInfo). */
export function LinkInfo() {
    return (
        <div>
            <h4>Lier un appareil</h4>
            <ol>
                <li>Choisissez le système de l&apos;appareil et ce que DevEye pourra y faire, puis générez un code.</li>
                <li>
                    Copiez la commande et lancez-la dans un terminal de l&apos;appareil : elle télécharge l&apos;agent
                    qui lui convient, puis le relie à votre espace. Un agent déjà installé n&apos;a besoin que de la
                    seconde forme, <code>deveye-agent link</code>.
                </li>
                <li>
                    L&apos;appareil est actif dès la liaison. Relier à nouveau une machine déjà connue de l&apos;espace
                    la remet « En attente d&apos;approbation » : approuvez-la depuis sa fiche, popup « Agent ».
                </li>
            </ol>
            <h4>Les codes</h4>
            <p>
                Un code relie autant d&apos;appareils que prévu à sa création, et expire au plus tard après sept jours.
                Chaque nouvel appareil compte dans l&apos;offre de l&apos;espace. Pour une flotte, l&apos;agent lit
                aussi le code dans la variable <code>DEVEYE_LINK_CODE</code>. Tout membre qui gère les appareils de
                l&apos;espace voit les codes actifs et peut les invalider.
            </p>
            <p>
                Un code à plusieurs usages ne relie jamais une machine déjà connue : deux copies d&apos;une même image
                se prendraient leur fiche. Donnez-leur chacune une identité (case « Machines clonées », ou{' '}
                <code>--shuffle-id</code>), ou générez un code à usage unique pour réappairer.
            </p>
            <h4>Les droits</h4>
            <p>
                Ce que DevEye peut faire sur un appareil se décide sur l&apos;appareil lui-même, au moment de le relier.
                Ni le serveur ni un compte compromis ne peuvent l&apos;élargir : seule la commande{' '}
                <code>deveye-agent policy</code>, lancée sur la machine, rend un droit.
            </p>
        </div>
    );
}
