import Button from '@/Components/Button';
import { TaskProgress } from '@/Components/TaskDialog';
import { TaskChip } from '@/Components/TopNavbar/TaskChip';
import { TaskRow } from '@/Components/TopNavbar/TaskRow';
import { runTask, useTasks } from '@/sdk/tasks';
import { LOST_NOTE, type ChipView, type TaskContext, type TaskRecord } from '@/stores/tasks';

import { Specimen, Variant } from '../Specimen';
import styles from '../Gallery.module.css';

const FEATURE = 'debug';

/** Un travail d'essai : il avance d'un pas par quart de seconde, puis réussit ou échoue. */
function sampleWork(seconds: number, task: TaskContext, opts: { fails?: boolean; signal?: AbortSignal } = {}) {
    return new Promise<void>((resolve, reject) => {
        const steps = seconds * 4;
        let done = 0;
        const timer = window.setInterval(() => {
            done += 1;
            task.report({ value: done / steps, step: `Étape ${done} sur ${steps}` });
            if (done < steps) return;
            window.clearInterval(timer);
            if (opts.fails) reject(new Error('panne'));
            else resolve();
        }, 250);
        opts.signal?.addEventListener('abort', () => {
            window.clearInterval(timer);
            reject(new Error('abandon'));
        });
    });
}

/** Le résultat d'un essai n'intéresse que la zone des opérations. */
const launch = (run: Promise<unknown>): void => void run.catch(() => undefined);

const CHIPS: readonly { label: string; chip: ChipView }[] = [
    { label: 'une en cours, mesurée', chip: { tone: 'running', count: 1, value: 0.4, alert: null } },
    { label: 'plusieurs, un échec attend', chip: { tone: 'running', count: 3, alert: 'failed' } },
    { label: 'échec', chip: { tone: 'failed', count: 1, alert: null } },
    { label: 'connexion coupée', chip: { tone: 'lost', count: 1, alert: null } },
    { label: 'succès non vus', chip: { tone: 'done', count: 2, alert: null } }
];

const BASE: TaskRecord = {
    id: 'sample',
    feature: FEATURE,
    title: 'Suppression du point de restauration',
    subject: 'Documents · point du 11/11/2026',
    origin: { instanceId: null, workspaceId: null },
    startedAt: 0,
    state: 'running',
    local: false,
    minimizable: true,
    cancellable: false,
    foreground: false,
    detached: true,
    raisedAt: 0,
    seen: false
};

const ROWS: readonly TaskRecord[] = [
    { ...BASE, id: 'running', value: 0.35, step: 'Libération de l’espace : 7 sur 20', cancellable: true },
    { ...BASE, id: 'done', state: 'done', note: 'Point de restauration supprimé.' },
    {
        ...BASE,
        id: 'failed',
        state: 'failed',
        error: { message: 'Suppression impossible.', code: 'internal' }
    },
    { ...BASE, id: 'lost', state: 'lost', error: { message: LOST_NOTE, code: 'closed' } }
];

const noop = (): void => undefined;

interface Sample {
    minimizable?: boolean;
    dialog?: boolean;
    /** Un travail de l'onglet, qui sait s'arrêter. */
    cancellable?: boolean;
    fails?: boolean;
}

function start(title: string, seconds: number, sample: Sample = {}): void {
    const abort = new AbortController();
    launch(
        runTask(
            {
                feature: FEATURE,
                title,
                subject: 'Galerie',
                description: 'Un travail factice, pour voir le dialogue, la puce et le panneau.',
                done: 'L’essai est allé au bout.',
                failed: 'L’essai a échoué, comme prévu.',
                minimizable: sample.minimizable,
                dialog: sample.dialog,
                ...(sample.cancellable ? { local: true, cancel: () => abort.abort() } : {})
            },
            (task) => sampleWork(seconds, task, { fails: sample.fails, signal: abort.signal })
        )
    );
}

/** Les opérations longues : des essais sur le vrai magasin, puis chaque état à plat. */
export function OperationsSpecimen({ disabled }: { disabled: boolean }) {
    const running = useTasks({ feature: FEATURE });

    return (
        <Specimen
            title='Opérations longues'
            note='runTask ouvre un dialogue qui se réduit : l’opération passe alors dans la puce de la barre et son panneau. Les essais tournent sur le vrai magasin.'
        >
            <Variant label='essais' wide>
                <Button variant='secondary' disabled={disabled} onClick={() => start('Essai réductible', 12)}>
                    Réductible
                </Button>
                <Button
                    variant='secondary'
                    disabled={disabled}
                    onClick={() => start('Essai bloquant', 4, { minimizable: false })}
                >
                    Bloquante
                </Button>
                <Button
                    variant='secondary'
                    disabled={disabled}
                    onClick={() => start('Essai annulable', 12, { cancellable: true })}
                >
                    Annulable
                </Button>
                <Button
                    variant='secondary'
                    disabled={disabled}
                    onClick={() => start('Essai qui échoue', 4, { fails: true })}
                >
                    Qui échoue
                </Button>
                <Button
                    variant='secondary'
                    disabled={disabled}
                    onClick={() => start('Essai sans dialogue', 12, { dialog: false })}
                >
                    Sans dialogue
                </Button>
            </Variant>
            <Variant label='TaskProgress, en place' wide fill>
                {running.length === 0 ? (
                    <p className={styles.demoText}>Lancez un essai : son avancement se dessine ici aussi.</p>
                ) : (
                    running.map((task) => <TaskProgress key={task.id} task={task} />)
                )}
            </Variant>
            {CHIPS.map(({ label, chip }) => (
                <Variant key={label} label={`puce : ${label}`}>
                    <TaskChip chip={chip} open={false} panelId='gallery-tasks' onClick={noop} />
                </Variant>
            ))}
            <Variant label='lignes du panneau' wide>
                <div className={styles.taskRows}>
                    {ROWS.map((task) => (
                        <TaskRow
                            key={task.id}
                            task={task}
                            feature={{ label: 'CloudSync', icon: 'cloud' }}
                            workspaceName={task.id === 'done' ? 'Atelier' : null}
                            onShow={noop}
                            onCancel={noop}
                            onOpen={noop}
                            onDismiss={noop}
                        />
                    ))}
                </div>
            </Variant>
        </Specimen>
    );
}

export default OperationsSpecimen;
