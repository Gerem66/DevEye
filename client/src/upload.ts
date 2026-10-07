/**
 * Les fichiers qu'un module fait monter : l'envoi avec sa progression, le
 * choix par le sélecteur du système et le dépôt de dossiers entiers.
 * `XMLHttpRequest` et non `fetch` : lui seul dit combien d'octets sont partis.
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

/** Un fichier choisi ou déposé, avec son chemin relatif, nom compris (`photos/a.jpg`, `a.jpg` hors dossier). */
export interface PickedFile {
    file: File;
    path: string;
}

/**
 * Le fichier part tel quel, sans découpage ni encodage. `onProgress` reçoit une
 * part de 0 à 1 ; à 1 le serveur n'a pas fini : il écrit et vérifie encore.
 */
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

/**
 * Déclenche le téléchargement d'une adresse servie en pièce jointe, sans quitter la page.
 * Sans `download`, le clic est une navigation, et Firefox coupe la socket dès
 * qu'elle commence. L'attribut ne vaut que sur l'origine de l'app : un chemin.
 */
export function saveFrom(url: string): void {
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
}

/**
 * Ouvre le sélecteur du système. `folder` choisit un dossier entier (ses
 * fichiers, chemins relatifs compris) ; une annulation rend une liste vide.
 */
export function pickFiles(opts: { multiple?: boolean; folder?: boolean; accept?: string } = {}): Promise<PickedFile[]> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = opts.multiple === true || opts.folder === true;
        if (opts.folder) input.webkitdirectory = true;
        if (opts.accept) input.accept = opts.accept;
        input.addEventListener('change', () =>
            resolve([...(input.files ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name })))
        );
        input.addEventListener('cancel', () => resolve([]));
        input.click();
    });
}

/** Lit un dépôt : les fichiers, et le contenu des dossiers déposés, récursivement. */
export async function filesOfDrop(data: DataTransfer): Promise<PickedFile[]> {
    const entries = [...data.items]
        .filter((item) => item.kind === 'file')
        .map((item) => item.webkitGetAsEntry?.() ?? null);
    if (entries.some((entry) => entry === null)) {
        return [...data.files].map((file) => ({ file, path: file.name }));
    }
    const out: PickedFile[] = [];
    for (const entry of entries as FileSystemEntry[]) await walk(entry, '', out);
    return out;
}

async function walk(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
    const path = `${prefix}${entry.name}`;
    if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        out.push({ file, path });
        return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // `readEntries` rend les enfants par lots (une centaine) : relire jusqu'au lot vide.
    for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, `${path}/`, out);
    }
}
