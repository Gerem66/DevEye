/** Explainer shown by the "Codes de liaison" dialog "i" button (via openInfo). */
export function LinkInfo() {
    return (
        <div>
            <h4>Lier un appareil</h4>
            <ol>
                <li>
                    Téléchargez l&apos;agent DevEye avec le bouton <b>« Télécharger l&apos;agent »</b> (Apple, Linux ou
                    Windows), puis placez le binaire sur l&apos;appareil à monitorer.
                </li>
                <li>
                    Générez un code ci-contre, puis exécutez sur l&apos;appareil :{' '}
                    <code>deveye-agent link &lt;code&gt; --server &lt;url&gt;</code>
                </li>
                <li>
                    L&apos;appareil est actif dès la liaison. Relier à nouveau une machine déjà connue de l&apos;espace
                    la remet « En attente d&apos;approbation » : approuvez-la depuis sa fiche, popup « Agent ».
                </li>
            </ol>
            <p>
                Un code est à usage unique et expire, une heure au plus. Tout membre qui gère les appareils de
                l&apos;espace voit les codes actifs et peut les invalider.
            </p>
        </div>
    );
}
