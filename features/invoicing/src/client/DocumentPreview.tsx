import styles from './style.module.css';

/**
 * L'aperçu : exactement ce qui s'imprimera, parce que c'est la même chaîne. Il
 * ne la charge pas lui-même, c'est la fiche qui la tient : le bouton
 * d'impression vit dans le bandeau du bas, et les deux doivent partir du même
 * document.
 *
 * Surtout pas de `dangerouslySetInnerHTML` dans l'application : le document
 * hériterait du thème sombre et s'écarterait du papier dès la première feuille
 * de style touchée.
 */
export interface DocumentPreviewProps {
    html: string | null;
    error: string | null;
}

export default function DocumentPreview({ html, error }: DocumentPreviewProps) {
    if (html === null) {
        return (
            <p className={error !== null ? styles.error : styles.placeholder}>{error ?? 'Préparation de l’aperçu…'}</p>
        );
    }

    return (
        <div className={styles.preview}>
            <iframe className={styles.previewFrame} sandbox='' srcDoc={html} title='Aperçu du document' />
        </div>
    );
}
