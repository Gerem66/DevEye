/**
 * La liste de colonnes d'un SELECT, dérivée du type de ligne qu'il annonce :
 * une clé par colonne, toutes obligatoires, aucune en trop. `true` lit la
 * colonne du même nom, préfixée de l'alias ; une chaîne est l'expression SQL,
 * suffixée `AS colonne` sauf quand elle la nomme déjà. Renommer une colonne
 * dans le type casse ici, avant d'atteindre la base.
 */
export function selectColumns<Row extends object>(
    alias: string | null,
    spec: { [K in keyof Row]-?: true | string }
): string {
    return Object.entries<true | string>(spec)
        .map(([column, expr]) => {
            if (expr === true) return alias === null ? column : `${alias}.${column}`;
            return expr === column || expr.endsWith(`.${column}`) ? expr : `${expr} AS ${column}`;
        })
        .join(', ');
}
