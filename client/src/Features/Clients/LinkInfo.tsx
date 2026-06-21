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
                    Par défaut l&apos;appareil apparaît « En attente » — approuvez-le pour démarrer la collecte. Un code
                    en <b>auto-approbation</b> l&apos;active directement à la liaison.
                </li>
            </ol>
            <p>
                Un code est à usage unique et peut avoir une durée de validité. L&apos;auto-approbation se règle à la
                génération ou se bascule ensuite depuis le tableau.
            </p>
        </div>
    );
}
