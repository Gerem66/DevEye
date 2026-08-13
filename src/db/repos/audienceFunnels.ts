import { AUDIENCE_FUNNEL_MAX_STEPS, type AudienceFunnelRow, type AudienceFunnelStepRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Une marche résolue : ce qu'elle reconnaît, et l'identifiant du libellé. */
export interface ResolvedStep {
    kind: 'path' | 'event';
    /** `null` quand le site n'a **jamais** émis cette valeur. La marche vaut 0. */
    labelId: number | null;
}

/**
 * Les entonnoirs d'un site : leur définition, et la rétention marche par marche.
 *
 * Un dépôt à part parce que sa seule requête intéressante l'est vraiment — voir
 * {@link AudienceFunnelsRepo.retention}. Le reste n'est que du rangement.
 */
export interface AudienceFunnelsRepo {
    list(siteId: number): Promise<AudienceFunnelRow[]>;
    listSteps(siteId: number): Promise<AudienceFunnelStepRow[]>;
    /** L'entonnoir **et** son espace : la frontière d'accès de la feature. */
    findInWorkspace(funnelId: number, workspaceId: number): Promise<AudienceFunnelRow | null>;
    findByName(siteId: number, nameRef: string): Promise<AudienceFunnelRow | null>;
    count(siteId: number): Promise<number>;
    create(input: { siteId: number; nameRef: string; content: string }): Promise<number>;
    rename(funnelId: number, nameRef: string, content: string): Promise<void>;
    remove(funnelId: number): Promise<boolean>;
    /**
     * Remplace **toutes** les marches d'un entonnoir.
     *
     * Remplacer plutôt que rapiécer : une marche n'a pas d'identité propre — on
     * ne renomme pas la troisième marche, on redéfinit le parcours. Un `UPDATE`
     * ligne à ligne aurait demandé de suivre des identifiants que personne ne
     * regarde, pour le même résultat.
     */
    replaceSteps(
        funnelId: number,
        siteId: number,
        steps: { kind: string; labelRef: string; content: string }[]
    ): Promise<void>;
    /** Les libellés du site qui correspondent à ces condensés, s'ils existent. */
    resolveLabels(siteId: number, refs: { kind: string; labelRef: string }[]): Promise<Map<string, number>>;
    /** Visites arrivées à chaque marche, les précédentes franchies **dans l'ordre**. */
    retention(siteId: number, steps: ResolvedStep[], from: number, to: number): Promise<number[]>;
}

export function audienceFunnelsRepo(pool: Q): AudienceFunnelsRepo {
    return {
        async list(siteId) {
            const r = await pool.query<AudienceFunnelRow>(
                'SELECT * FROM audience_funnels WHERE site_id = ? ORDER BY sort_order ASC, id ASC',
                [siteId]
            );
            return r.rows;
        },
        async listSteps(siteId) {
            const r = await pool.query<AudienceFunnelStepRow>(
                'SELECT * FROM audience_funnel_steps WHERE site_id = ? ORDER BY funnel_id ASC, position ASC',
                [siteId]
            );
            return r.rows;
        },
        async findInWorkspace(funnelId, workspaceId) {
            // La jointure **est** la garde : un entonnoir d'un autre espace n'a
            // pas à exister pour l'appelant, pas même comme refus distinct.
            const r = await pool.query<AudienceFunnelRow>(
                `SELECT f.* FROM audience_funnels f
                   JOIN audience_sites s ON s.id = f.site_id
                  WHERE f.id = ? AND s.workspace_id = ?`,
                [funnelId, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async findByName(siteId, nameRef) {
            const r = await pool.query<AudienceFunnelRow>(
                'SELECT * FROM audience_funnels WHERE site_id = ? AND name_ref = ?',
                [siteId, nameRef]
            );
            return r.rows[0] ?? null;
        },
        async count(siteId) {
            const r = await pool.query<{ total: number }>(
                'SELECT COUNT(*) AS total FROM audience_funnels WHERE site_id = ?',
                [siteId]
            );
            return Number(r.rows[0]?.total ?? 0);
        },
        async create(input) {
            const posRow = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM audience_funnels WHERE site_id = ?',
                [input.siteId]
            );
            const res = await pool.query(
                'INSERT INTO audience_funnels (site_id, name_ref, sort_order, content) VALUES (?, ?, ?, ?)',
                [input.siteId, input.nameRef, Number(posRow.rows[0]?.next ?? 0), input.content]
            );
            return Number(res.insertId);
        },
        async rename(funnelId, nameRef, content) {
            await pool.query('UPDATE audience_funnels SET name_ref = ?, content = ? WHERE id = ?', [
                nameRef,
                content,
                funnelId
            ]);
        },
        async remove(funnelId) {
            // Les marches partent en CASCADE. Aucune mesure n'est touchée : un
            // entonnoir ne collecte rien, il relit.
            const r = await pool.query('DELETE FROM audience_funnels WHERE id = ?', [funnelId]);
            return r.rowCount > 0;
        },
        async replaceSteps(funnelId, siteId, steps) {
            await pool.query('DELETE FROM audience_funnel_steps WHERE funnel_id = ?', [funnelId]);
            if (steps.length === 0) return;
            const placeholders = steps.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
            const params: unknown[] = [];
            steps.forEach((step, index) => {
                params.push(funnelId, siteId, index, step.kind, step.labelRef, step.content);
            });
            await pool.query(
                `INSERT INTO audience_funnel_steps (funnel_id, site_id, position, match_kind, label_ref, content)
                 VALUES ${placeholders}`,
                params
            );
        },
        async resolveLabels(siteId, refs) {
            if (refs.length === 0) return new Map();
            const placeholders = refs.map(() => '?').join(', ');
            const r = await pool.query<{ id: number; kind: string; label_ref: string }>(
                `SELECT id, kind, label_ref FROM audience_labels
                  WHERE site_id = ? AND label_ref IN (${placeholders})`,
                [siteId, ...refs.map((ref) => ref.labelRef)]
            );
            // Indexé sur `kind:ref` et non sur le seul condensé : le même texte
            // peut parfaitement être à la fois un chemin et un nom d'événement,
            // et ce sont alors deux libellés distincts.
            const byKey = new Map<string, number>();
            for (const row of r.rows) byKey.set(`${row.kind}:${row.label_ref}`, Number(row.id));
            return byKey;
        },

        async retention(siteId, steps, from, to) {
            if (steps.length === 0) return [];

            // Une marche sans libellé n'a jamais été atteinte : elle vaut zéro,
            // et tout ce qui la suit aussi. On coupe ici plutôt que de laisser
            // la requête le découvrir, ce qui revient au même en moins clair.
            const firstMissing = steps.findIndex((step) => step.labelId === null);
            const measurable = firstMissing === -1 ? steps : steps.slice(0, firstMissing);
            if (measurable.length === 0) return steps.map(() => 0);

            // ⚠️ Les seules parties **interpolées** sont un indice de colonne
            // (`t1`, `t2`…) et le nom d'une colonne d'événement, tirés d'un
            // vocabulaire fermé et bornés par `AUDIENCE_FUNNEL_MAX_STEPS`. Les
            // identifiants de libellés, eux, sont liés. C'est la discipline de
            // `DIMENSION_SOURCE` : on ne met dans le texte de la requête que ce
            // que le serveur a lui-même écrit.
            const n = Math.min(measurable.length, AUDIENCE_FUNNEL_MAX_STEPS);
            const params: unknown[] = [];

            const firsts = measurable.slice(0, n).map((step, i) => {
                const column = step.kind === 'path' ? 'path_id' : 'name_id';
                const eventKind = step.kind === 'path' ? 0 : 1;
                params.push(eventKind, step.labelId);
                // La **première** occurrence de chaque marche : c'est la règle,
                // et elle doit être dite. Un visiteur qui revient en arrière puis
                // repart peut donc ne pas être compté comme converti — le prix
                // d'une définition déterministe qui tient en une requête.
                return `MIN(CASE WHEN e.kind = ? AND e.${column} = ? THEN e.ts END) AS t${i + 1}`;
            });

            // La condition de la marche i : toutes les précédentes présentes, et
            // dans l'ordre. Construite par accumulation, exactement comme on la
            // lit — « arrivé jusqu'ici » veut dire « et pas autrement ».
            //
            // ⚠️ **`>=` et non `>`, et ce n'est pas une facilité.** Nos
            // horodatages sont à la seconde, et le script groupe ses envois sur
            // une demi-seconde : un même clic produit couramment une vue et un
            // événement **dans la même seconde**. Avec `>`, tout entonnoir dont
            // deux marches consécutives naissent du même geste — « ouvrir
            // /devis » puis « devis-ouvert » — compterait zéro conversion, sans
            // rien pour l'expliquer.
            const conditions: string[] = [];
            let chain = 't1 IS NOT NULL';
            conditions.push(chain);
            for (let i = 2; i <= n; i++) {
                chain += ` AND t${i} IS NOT NULL AND t${i} >= t${i - 1}`;
                conditions.push(chain);
            }
            const sums = conditions.map((cond, i) => `COALESCE(SUM(${cond}), 0) AS s${i + 1}`);

            params.push(siteId, from, to);

            const r = await pool.query<Record<string, number>>(
                `SELECT ${sums.join(', ')}
                   FROM (SELECT e.session_id, ${firsts.join(', ')}
                           FROM audience_events e
                          WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ?
                          GROUP BY e.session_id) x`,
                params
            );

            const row = r.rows[0];
            const counts = measurable.slice(0, n).map((_, i) => Number(row?.[`s${i + 1}`] ?? 0));
            // Les marches coupées plus haut reprennent leur place, à zéro.
            while (counts.length < steps.length) counts.push(0);
            return counts;
        }
    };
}
