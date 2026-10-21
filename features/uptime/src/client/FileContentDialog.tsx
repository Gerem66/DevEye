import { useEffect, useRef, useState } from 'react';
import { Button, copyText, Dialog, ErrorNote, errorNote, type ErrorNoteInput } from 'deveye-sdk-client';

import { api } from './api';
import styles from './style.module.css';

interface FileContentDialogProps {
    serviceId: number;
    /** Le chemin à lire, `null` fermé. */
    path: string | null;
    onClose: () => void;
}

interface Content {
    status: number;
    contentType: string | null;
    text: string;
    truncated: boolean;
}

/** « 12,3 Kio » : la taille de ce qui a été lu. */
function formatSize(text: string): string {
    const bytes = new TextEncoder().encode(text).length;
    return bytes < 1024 ? `${bytes} o` : `${(bytes / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Kio`;
}

/** Ce que le site sert à un chemin, relu par le serveur et montré en texte brut : rien ne s'exécute. */
export function FileContentDialog({ serviceId, path, onClose }: FileContentDialogProps) {
    const shown = useRef<string | null>(path);
    if (path !== null) shown.current = path;
    const [content, setContent] = useState<Content | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (path === null) return;
        let cancelled = false;
        setContent(null);
        setError(null);
        setCopied(false);
        api.send('uptime.fileContent', { id: serviceId, path })
            .then((res) => {
                if (!cancelled) setContent(res);
            })
            .catch((e: unknown) => {
                if (!cancelled) setError(errorNote(e, 'Fichier illisible.'));
            });
        return () => {
            cancelled = true;
        };
    }, [serviceId, path]);

    const copy = () => {
        if (!content) return;
        void copyText(content.text).then((ok) => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        });
    };

    const description = content
        ? [
              'Ce que le site sert maintenant',
              `HTTP ${content.status}`,
              content.contentType ?? 'type non annoncé',
              content.truncated ? `les ${formatSize(content.text)} premiers` : formatSize(content.text)
          ].join(' · ')
        : 'Ce que le site sert maintenant, en texte brut.';

    return (
        <Dialog
            open={path !== null}
            onClose={onClose}
            title={shown.current ?? undefined}
            description={description}
            width={860}
            fill
            footer={
                <Button variant='secondary' icon='copy' onClick={copy} disabled={!content}>
                    {copied ? 'Copié' : 'Copier'}
                </Button>
            }
        >
            <ErrorNote note={error} />
            {content ? (
                <pre className={styles.fileText}>{content.text}</pre>
            ) : (
                error === null && <p className={styles.empty}>Lecture…</p>
            )}
        </Dialog>
    );
}

export default FileContentDialog;
