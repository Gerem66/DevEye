import { useEffect, useState } from 'react';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { BackupEncryption } from '../contracts/domain';

import {
    Button,
    humanizeError,
    invalidate,
    SegmentedControl,
    settingsStyles as shell,
    useResource
} from 'deveye-sdk-client';
import { api } from './api';

/**
 * La forme des archives d'un travail, pour les archives à venir (chaque
 * exécution fige la sienne). Pas de chiffrement par mot de passe : la clé
 * dérivée du mot de passe ne vit qu'en session déverrouillée, et
 * l'ordonnanceur tourne sans session (voir Docs/SECURITY_MODEL.md).
 */
export default function JobEncryptionPanel({ scope, canWrite }: SettingsPanelProps) {
    const jobId = scope.kind === 'item' ? scope.itemId : null;
    const { data: job, error: loadError } = useResource(
        'backup.detail',
        () => api.send('backup.jobGet', { jobId: jobId ?? 0, limit: 1 }).then((res) => res.job),
        'Chargement impossible.',
        [jobId]
    );
    const [mode, setMode] = useState<BackupEncryption>('server');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);

    // Suit le travail chargé seulement : une relecture (le sujet live bat à
    // chaque exécution) ne doit pas effacer un choix en cours.
    useEffect(() => {
        if (job) setMode(job.encryption);
    }, [job?.encryption, job]);

    if (!job) return <p className={loadError ? shell.notice : shell.empty}>{loadError ?? 'Chargement…'}</p>;

    const save = async () => {
        setBusy(true);
        setStatus(null);
        try {
            await api.send('backup.jobUpdate', {
                jobId: job.id,
                name: job.name,
                destinationId: job.destinationId,
                source: job.source,
                sourceId: job.sourceId,
                enabled: job.enabled,
                schedule: job.schedule,
                scheduleHour: job.scheduleHour,
                scheduleWeekday: job.scheduleWeekday,
                scheduleDay: job.scheduleDay,
                keepLast: job.keepLast,
                encryption: mode
            });
            invalidate('backup.detail', 'backup.jobList');
            setStatus('Forme enregistrée : elle vaut pour les prochaines archives.');
        } catch (e) {
            setStatus(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    if (job.foreign) {
        return (
            <p className={shell.sectionHint}>
                Ce travail vient d’un autre espace : la forme de ses archives se règle depuis là-bas.
            </p>
        );
    }

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.fieldLabel}>Forme des archives</span>
                <SegmentedControl
                    aria-label='Forme des archives'
                    value={mode}
                    disabled={busy || !canWrite}
                    onChange={setMode}
                    options={[
                        {
                            value: 'none',
                            label: 'En clair',
                            title: 'Lisible par qui tient la destination'
                        },
                        {
                            value: 'server',
                            label: 'Chiffrée (clé du serveur)',
                            title: 'Scellée sous une clé dérivée de CRYPT_KEY_A / CRYPT_KEY_B'
                        }
                    ]}
                />
            </div>

            <p className={shell.fieldHint}>
                {mode === 'server'
                    ? 'Les archives sont illisibles pour qui tient la destination. La clé est dérivée de CRYPT_KEY_A / CRYPT_KEY_B, jamais stockée : sans ces deux variables, une archive chiffrée est irrécupérable ; avec elles, scripts/restore-backup.mjs la rouvre sans base ni serveur.'
                    : 'Les archives sont écrites telles quelles : qui tient la destination peut les lire. À réserver à un disque déjà sous la même garde que le serveur.'}
            </p>

            <p className={shell.fieldHint}>
                Il n’existe pas de chiffrement par le mot de passe de l’espace, et ce n’est pas un oubli :
                l’ordonnanceur tourne la nuit sans session, et le serveur ne détient jamais cette clé hors d’une session
                déverrouillée. Le choix vaut pour les archives à venir ; celles déjà écrites gardent la forme figée par
                leur exécution.
            </p>

            {canWrite ? (
                <div className={shell.sectionActions}>
                    <Button onClick={() => void save()} disabled={busy || mode === job.encryption}>
                        {busy ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </div>
            ) : (
                <p className={shell.sectionHint}>
                    Votre rôle ne permet pas de modifier la forme des archives : elle relève de l’écriture sur les
                    Sauvegardes.
                </p>
            )}

            {status && <p className={shell.notice}>{status}</p>}
        </div>
    );
}
