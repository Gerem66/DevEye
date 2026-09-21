import { useEffect, useState } from 'react';

/**
 * Une adresse `blob:` pour montrer un fichier sans l'envoyer nulle part. Elle
 * est révoquée dès que le fichier change ou que l'écran se démonte : une adresse
 * oubliée retient le fichier entier en mémoire.
 *
 * Sans source, pas d'adresse, et tout de suite : celle d'avant ne survit pas à
 * un passage par `null`. D'une source à la suivante, en revanche, l'ancienne
 * tient le temps d'un rendu, pour que l'image se remplace sans clignoter.
 *
 * `type` impose le type du contenu : c'est lui, et non le nom du fichier, qui
 * décide de ce que le navigateur en fait.
 */
export function useObjectUrl(source: Blob | null, type?: string): string | null {
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        if (!source) return setUrl(null);
        const next = URL.createObjectURL(type ? new Blob([source], { type }) : source);
        setUrl(next);
        return () => URL.revokeObjectURL(next);
    }, [source, type]);
    return source ? url : null;
}
