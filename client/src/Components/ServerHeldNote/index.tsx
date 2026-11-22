/**
 * Sous le champ d'un identifiant que le serveur relit seul : la même phrase
 * partout, pour que personne ne le croie verrouillé par son mot de passe.
 * Sans style propre : elle se pose dans l'aide du champ et en prend l'allure.
 *
 * `purpose` : ce que le serveur en fait, à l'infinitif (« relever la base »).
 */
export default function ServerHeldNote({ purpose }: { purpose: string }) {
    return <>Le serveur garde de quoi relire cet identifiant : il s’en sert pour {purpose}, sans vous.</>;
}
