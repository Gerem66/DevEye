import { useEffect, useState } from 'react';

/**
 * En dessous de cette largeur, la fiche d'une CVE occupe toute la page au lieu
 * de s'ouvrir à droite de la liste. Le même seuil qu'en CSS : les deux doivent
 * basculer ensemble, sinon le geste de sortie ne dit pas ce qu'il fait.
 */
export const DETAIL_AS_PAGE = '(max-width: 1000px)';

/**
 * La fiche tient-elle la page entière ? Sortir est alors un RETOUR vers la
 * liste, quand à côté d'elle c'est une fermeture : deux gestes différents, deux
 * icônes différentes.
 */
export function useDetailAsPage(): boolean {
    const [asPage, setAsPage] = useState(() => window.matchMedia(DETAIL_AS_PAGE).matches);

    useEffect(() => {
        const query = window.matchMedia(DETAIL_AS_PAGE);
        const onChange = (): void => setAsPage(query.matches);
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }, []);

    return asPage;
}
