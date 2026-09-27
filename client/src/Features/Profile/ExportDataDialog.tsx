import { useEffect, useState } from 'react';
import type { UserExportPart } from '@deveye/types';

import { humanizeError } from '@/api/useResource';
import { ws, WsError } from '@/api/ws';
import { TextInput } from '@/Components';
import Button from '@/Components/Button';
import ChoiceCards from '@/Components/ChoiceCards';
import { Dialog } from '@/Components/Dialog';
import Switch from '@/Components/Switch';
import { formatBytesFr } from '@/format';

import styles from './style.module.css';

interface ExportDataDialogProps {
    open: boolean;
    onClose: () => void;
}

type Scope = 'all' | 'lite';

function humanize(err: unknown): string {
    if (err instanceof WsError && err.code === 'auth_invalid') return 'Mot de passe incorrect.';
    return humanizeError(err, 'L’export n’a pas pu être préparé.');
}

/**
 * L'export de toutes les données du compte. Le mot de passe est redemandé :
 * l'archive porte en clair ce qu'il protège. Elle s'écrit pendant son
 * téléchargement et n'existe nulle part ailleurs ; le lien ne sert qu'une fois.
 */
export function ExportDataDialog({ open, onClose }: ExportDataDialogProps) {
    const [parts, setParts] = useState<UserExportPart[] | null>(null);
    const [foreign, setForeign] = useState(0);
    const [scope, setScope] = useState<Scope>('all');
    const [kept, setKept] = useState<Record<string, boolean>>({});
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [started, setStarted] = useState(false);
    // Le compte de cette instance, même quand un espace distant est affiché : le lien s'ouvre avec son cookie.
    const local = ws.connectionFor(null);

    useEffect(() => {
        if (!open || !local) return;
        setParts(null);
        setScope('all');
        setKept({});
        setPassword('');
        setError(null);
        setStarted(false);
        local
            .send('user.exportPreview', {})
            .then((preview) => {
                setParts(preview.parts);
                setForeign(preview.foreignWorkspaces);
            })
            .catch((e: unknown) => setError(humanizeError(e, 'Les données du compte sont illisibles.')));
    }, [open, local]);

    const optional = (parts ?? []).filter((part) => part.optional && part.bytes > 0);
    const single = optional.length === 1 ? optional[0] : null;
    const leaveOut = single
        ? scope === 'lite'
            ? [single.key]
            : []
        : optional.filter((part) => kept[part.key] === false).map((part) => part.key);
    const bytes = (parts ?? [])
        .filter((part) => !leaveOut.includes(part.key))
        .reduce((sum, part) => sum + part.bytes, 0);

    const close = (): void => {
        if (loading) return;
        onClose();
    };

    const onSubmit = async (): Promise<void> => {
        if (loading || !local) return;
        if (!password) {
            setError('Le mot de passe est requis.');
            return;
        }
        setError(null);
        setLoading(true);
        try {
            const { url } = await local.send('user.exportPrepare', { password, leaveOut });
            const link = document.createElement('a');
            link.href = url;
            // Un refus du serveur reste un téléchargement raté, jamais une page qui remplace l'app.
            link.download = '';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setPassword('');
            setStarted(true);
        } catch (err) {
            setError(humanize(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={close}
            title='Exporter mes données'
            onSubmit={started ? close : () => void onSubmit()}
            footer={
                started ? (
                    <Button onClick={close}>Fermer</Button>
                ) : (
                    <>
                        <Button variant='secondary' onClick={close} disabled={loading}>
                            Annuler
                        </Button>
                        <Button icon='download' onClick={() => void onSubmit()} disabled={loading || parts === null}>
                            {loading ? 'Préparation…' : 'Télécharger l’archive'}
                        </Button>
                    </>
                )
            }
        >
            <div className={styles.form}>
                {started ? (
                    <p className={styles.formSuccess}>
                        Le téléchargement a commencé. Le lien ne sert qu’une fois et expire au bout de cinq minutes : si
                        rien ne vient, recommencez.
                    </p>
                ) : (
                    <>
                        <p className={styles.hint}>
                            Une archive .zip de tout ce que contient votre compte : votre profil, chaque espace que vous
                            possédez et, dans chacun, les données de chaque fonctionnalité. Elle se fabrique pendant le
                            téléchargement et n’est gardée nulle part.
                            {foreign > 0 &&
                                ` Les ${foreign} espace(s) dont vous n’êtes que membre y sont listés, sans leurs données, qui appartiennent à leur propriétaire.`}
                        </p>
                        {single && (
                            <ChoiceCards<Scope>
                                value={scope}
                                onChange={setScope}
                                aria-label='Contenu de l’archive'
                                options={[
                                    {
                                        value: 'all',
                                        label: 'Tout',
                                        description: `Toutes vos données, ${single.label} compris (${formatBytesFr(single.bytes)}).`
                                    },
                                    {
                                        value: 'lite',
                                        label: `Tout sauf ${single.label}`,
                                        description: `Une archive plus légère, sans ${single.label}.`
                                    }
                                ]}
                            />
                        )}
                        {optional.length > 1 &&
                            optional.map((part) => (
                                <Switch
                                    key={part.key}
                                    checked={kept[part.key] !== false}
                                    onChange={(checked) => setKept({ ...kept, [part.key]: checked })}
                                    label={`Inclure ${part.label}`}
                                    hint={formatBytesFr(part.bytes)}
                                />
                            ))}
                        {bytes > 0 && (
                            <p className={styles.hint}>
                                Les fichiers de l’archive pèsent environ {formatBytesFr(bytes)}.
                            </p>
                        )}
                        <p className={styles.exportWarning}>
                            Cette archive contient vos mots de passe en clair : ceux du coffre, vos notes privées, vos
                            recherches OSINT. Gardez-la en lieu sûr, et supprimez-la quand vous n’en avez plus besoin.
                        </p>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Votre mot de passe, pour confirmer</span>
                            <TextInput
                                type='password'
                                enableShowHideButton
                                autoComplete='current-password'
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                            />
                        </label>
                    </>
                )}
                {error && <p className={styles.formError}>{error}</p>}
            </div>
        </Dialog>
    );
}
