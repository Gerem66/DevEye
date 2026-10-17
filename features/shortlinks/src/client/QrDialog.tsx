import {
    Button,
    Dialog,
    DialogCancelButton,
    errorNote,
    ErrorNote,
    SegmentedControl,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { useEffect, useState } from 'react';

import type { Shortlink } from '../contracts/domain';
import { api } from './api';
import { displayTitle } from './format';
import styles from './style.module.css';

type Address = 'short' | 'domain';

/** Propose le fichier au navigateur, puis rend l'URL temporaire. */
function downloadSvg(name: string, svg: string): void {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Le QR code d'un lien, à imprimer sur une affiche ou un flyer. Le serveur le
 * dessine en SVG ; il s'affiche en image, où aucun script ne s'exécute.
 */
export default function QrDialog({ link, open, onClose }: { link: Shortlink; open: boolean; onClose: () => void }) {
    const hasDomain = link.domainUrl !== null;
    const [address, setAddress] = useState<Address>(hasDomain ? 'domain' : 'short');
    const [qr, setQr] = useState<{ url: string; svg: string } | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    useEffect(() => {
        if (!open) return;
        const chosen: Address = hasDomain ? address : 'short';
        let live = true;
        setError(null);
        api.send('shortlinks.qr', { id: link.id, address: chosen })
            .then((result) => {
                if (live) setQr(result);
            })
            .catch((failure: unknown) => {
                if (live) setError(errorNote(failure, 'Le QR code n’a pas pu être dessiné.'));
            });
        return () => {
            live = false;
        };
    }, [open, link.id, address, hasDomain]);

    const name = `qr-${link.slug || link.code}.svg`;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='QR code du lien'
            description='Scanné avec un téléphone, il ouvre le lien. Les visites qui en viennent se comptent comme les autres.'
            footer={
                <>
                    <DialogCancelButton variant='ghost'>Fermer</DialogCancelButton>
                    <Button icon='download' disabled={qr === null} onClick={() => qr && downloadSvg(name, qr.svg)}>
                        Télécharger (.svg)
                    </Button>
                </>
            }
        >
            <div className={styles.qrBody}>
                {hasDomain && (
                    <SegmentedControl<Address>
                        value={address}
                        aria-label='Adresse du QR code'
                        fullWidth
                        options={[
                            { value: 'domain', label: link.domainHost ?? 'Votre domaine' },
                            { value: 'short', label: 'Adresse de DevEye' }
                        ]}
                        onChange={setAddress}
                    />
                )}
                {error !== null ? (
                    <ErrorNote note={error} />
                ) : qr === null ? (
                    <p className={styles.empty}>Dessin du QR code…</p>
                ) : (
                    <>
                        <img
                            className={styles.qrImage}
                            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`}
                            alt={`QR code menant à ${qr.url}, pour « ${displayTitle(link)} »`}
                        />
                        <p className={styles.qrUrl}>{qr.url}</p>
                    </>
                )}
                <p className={styles.qrHint}>
                    Le SVG s’agrandit sans perdre en netteté : il convient à l’impression comme à l’écran.
                </p>
            </div>
        </Dialog>
    );
}
