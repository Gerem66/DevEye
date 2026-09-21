/**
 * La montée du fichier. `XMLHttpRequest` et non `fetch` : lui seul dit combien
 * d'octets sont partis. Le fichier part tel quel, sans découpage ni encodage.
 */

export interface UploadHandle {
    done: Promise<void>;
    abort(): void;
}

export class UploadError extends Error {
    constructor(
        message: string,
        public readonly aborted = false
    ) {
        super(message);
        this.name = 'UploadError';
    }
}

/** `onProgress` reçoit une part de 0 à 1. À 1 le serveur n'a pas fini : il écrit et vérifie encore le fichier. */
export function uploadFile(url: string, file: File, onProgress: (ratio: number) => void): UploadHandle {
    const xhr = new XMLHttpRequest();
    const done = new Promise<void>((resolve, reject) => {
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) onProgress(event.loaded / event.total);
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) return resolve();
            let message = 'L’envoi du fichier a échoué.';
            try {
                const body = JSON.parse(xhr.responseText) as { message?: unknown };
                if (typeof body.message === 'string') message = body.message;
            } catch {
                // Une réponse sans corps lisible garde la phrase générique.
            }
            reject(new UploadError(message));
        };
        xhr.onerror = () => reject(new UploadError('La connexion a été coupée pendant l’envoi.'));
        xhr.onabort = () => reject(new UploadError('Envoi annulé.', true));
        xhr.open('POST', url);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.send(file);
    });
    return { done, abort: () => xhr.abort() };
}

/** Déclenche le téléchargement d'une adresse servie en pièce jointe, sans quitter la page. */
export function saveFrom(url: string): void {
    const link = document.createElement('a');
    link.href = url;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
}
