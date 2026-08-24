import { useCallback, useEffect, useState } from 'react';
import type { BackupEncryption, BackupJob } from '@deveye/types';

import Button from '@/Components/Button';
import SegmentedControl from '@/Components/SegmentedControl';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { ws } from '@/api/ws';

import shell from '@/Components/FeatureSettings/FeatureSettings.module.css';
import { backupError } from './format';

/**
 * La forme des archives d'un travail : l'onglet Chiffrement de ses réglages.
 *
 * Deux formes, et deux seulement :
 *
 * - **En clair** : lisible par qui tient la destination. À réserver aux
 *   destinations déjà sous la même garde que le serveur.
 * - **Chiffrée (clé du serveur)** : scellée en AES-256-GCM sous une clé
 *   dérivée de CRYPT_KEY_A / CRYPT_KEY_B, jamais stockée, donc jamais dans
 *   l'archive qu'elle protège. `scripts/restore-backup.mjs` la re-dérive avec
 *   ces deux seules variables, sans base ni serveur.
 *
 * Le chiffrement **par mot de passe** n'existe pas ici, et ce n'est pas un
 * oubli : l'ordonnanceur tourne la nuit sans session, or la clé dérivée du
 * mot de passe ne vit que dans une session déverrouillée, en mémoire, à
 * fenêtre glissante. Un tel mode ne pourrait ni tourner planifié, ni survivre
 * à un vidage de plusieurs heures (même raison que CloudSync, voir
 * Docs/SECURITY_MODEL.md).
 *
 * Le choix vaut pour les archives **à venir** : chaque exécution fige la forme
 * qu'elle a réellement écrite, et l'historique l'affiche par passage.
 */
export default function BackupEncryptionPanel({ jobId }: { jobId: number }) {
    const version = useResourceVersion('backup.detail');
    const [job, setJob] = useState<BackupJob | null>(null);
    const [mode, setMode] = useState<BackupEncryption>('server');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await ws.send('backup.jobGet', { jobId, limit: 1 });
            setJob(res.job);
            setMode(res.job.encryption);
        } catch (e) {
            setStatus(backupError(e, 'Chargement impossible.'));
        }
    }, [jobId]);

    useEffect(() => {
        void load();
    }, [load, version]);

    if (!job) return <p className={shell.sectionHint}>{status ?? 'Chargement…'}</p>;

    const save = async () => {
        setBusy(true);
        setStatus(null);
        try {
            await ws.send('backup.jobUpdate', {
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
            setStatus(backupError(e, 'Enregistrement impossible.'));
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
        <>
            <div className={shell.field}>
                <span className={shell.fieldLabel}>Forme des archives</span>
                <SegmentedControl
                    aria-label='Forme des archives'
                    value={mode}
                    disabled={busy}
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

            <div className={shell.sectionActions}>
                <Button onClick={() => void save()} disabled={busy || mode === job.encryption}>
                    {busy ? 'Enregistrement…' : 'Enregistrer'}
                </Button>
            </div>

            {status && <p className={shell.notice}>{status}</p>}
        </>
    );
}
