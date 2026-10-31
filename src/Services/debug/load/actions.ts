/** Ce qu'une page ouvre à son arrivée, quoi qu'il y ait sur l'accueil. */
const SESSION_READS = ['secrecy.status', 'user.plan', 'user.invitations'];

const NOTE_CYCLE = ['notes.add', 'notes.edit', 'notes.archive', 'notes.delete'];

export type Send = <T>(command: string, input: unknown) => Promise<T>;

/** Ce que la découverte lit d'une commande du dispatcheur. */
export interface CommandSpec {
    command: string;
    input: { safeParse(value: unknown): { success: boolean } };
    access?: { admin?: true; moderation?: true };
    mutates?: unknown;
}

export interface LoadActions {
    /** L'arrivée : la session, puis la tuile de chaque fonctionnalité (`*.count`). */
    home: readonly string[];
    /** Ouvrir une vue (`*.list`). */
    views: readonly string[];
    /** Notes est installé : un utilisateur écrit aussi. */
    writes: boolean;
}

/**
 * Les lectures qu'un utilisateur simulé envoie, trouvées dans le registre : un
 * `count` ou un `list` sans paramètre requis, qui n'écrit pas et n'est pas
 * réservé à l'administration. Un module ajouté est couvert sans rien toucher.
 */
export function discoverActions(commands: readonly CommandSpec[]): LoadActions {
    const known = new Set(commands.map((def) => def.command));
    const reads = commands
        .filter(
            (def) => !def.mutates && !def.access?.admin && !def.access?.moderation && def.input.safeParse({}).success
        )
        .map((def) => def.command);
    return {
        home: [...SESSION_READS.filter((c) => known.has(c)), ...reads.filter((c) => c.endsWith('.count'))],
        views: reads.filter((c) => c.endsWith('.list')),
        writes: NOTE_CYCLE.every((c) => known.has(c))
    };
}

const draft = (title: string, done: boolean) => ({
    title,
    folderId: null,
    private: false,
    blocks: [
        { type: 'text', text: 'Montée en charge.' },
        { type: 'check', text: 'À relire', done }
    ]
});

/**
 * Une note écrite, relue puis jetée, comme le scénario de bout en bout de
 * Notes. Interrompu en route, ce qui reste part avec le compte au ménage.
 */
export async function noteCycle(send: Send): Promise<void> {
    const { note } = await send<{ note: { id: number } }>('notes.add', { note: draft('Note de charge', false) });
    await send('notes.edit', { noteId: note.id, note: draft('Note de charge (relue)', true) });
    await send('notes.archive', { noteId: note.id });
    await send('notes.delete', { noteId: note.id });
}
