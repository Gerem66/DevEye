import { AUDIENCE_ANSWER_ROWS_MAX, type AudienceFormRow, type AudienceSubmissionRow } from '../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/**
 * Ce que les retours écrivent et lisent. Section détachée de `repo.ts`, qui
 * porte déjà les sites, les agrégats, les entonnoirs et le chemin chaud de la
 * mesure ; les deux se rejoignent dans un seul `AudienceRepo`.
 *
 * Mêmes règles qu'à côté : tout paramètre est lié, et le dépôt ne chiffre
 * jamais (l'appelant lui passe du déjà scellé).
 */

/** Un retour, plus le contexte de sa visite, tout **encore chiffré**. */
export interface AudienceSubmissionWithContextRow extends AudienceSubmissionRow {
    entry_path_content: string | null;
    referrer_content: string | null;
    browser_content: string | null;
    device_content: string | null;
}

/** Une ligne de répartition : le libellé chiffré, ou le seau, et son compte. */
export interface AudienceAnswerReadRow {
    field_id: number;
    field_content: string;
    value_id: number;
    value_content: string | null;
    hits: number;
}

/** Ce que la carte « Retours » du sommaire montre, déjà en nombres. */
export interface AudienceFeedbackStats {
    forms: number;
    submissions: number;
    last7d: number;
    lastAt: number | null;
}

export interface AudienceDailyPointRow {
    day: number;
    views: number;
}

export interface AudienceFormsRepo {
    // -- formulaires --------------------------------------------------------
    listForms(siteId: number): Promise<AudienceFormRow[]>;
    findForm(formId: number): Promise<AudienceFormRow | null>;
    findFormByName(siteId: number, nameRef: string): Promise<AudienceFormRow | null>;
    countForms(siteId: number): Promise<number>;
    createForm(input: {
        siteId: number;
        nameRef: string;
        content: string;
        mode: string;
        formSchema: string | null;
        sortOrder: number;
    }): Promise<number>;
    updateForm(input: {
        formId: number;
        nameRef: string;
        content: string;
        mode: string;
        formSchema: string | null;
        open: boolean;
    }): Promise<void>;
    /**
     * Ferme un formulaire sans qu'on l'ait demandé, en inscrivant pourquoi. Un
     * seul motif subsiste, le plafond de stockage : une rafale écarte la
     * provenance qui l'envoie et ne touche pas au canal.
     */
    closeForm(formId: number, at: number, reason: string): Promise<void>;
    removeForm(formId: number): Promise<boolean>;
    /** Vide un formulaire sans le supprimer : le canal reste, l'historique part. */
    clearForm(formId: number): Promise<number>;

    // -- réception (sans session) -------------------------------------------
    insertSubmission(input: {
        formId: number;
        siteId: number;
        ts: number;
        ipRef: string;
        sessionId: number | null;
        content: string;
    }): Promise<number>;
    /**
     * Envois d'une même provenance vers ce formulaire depuis `since`, et envois
     * du formulaire toutes provenances confondues. Le motif du plafond horaire
     * des signalements du socle : un `COUNT(*)` sur la table métier, servi par
     * un index composite, sans table de compteurs ni fenêtre à purger.
     */
    countSubmissionsSince(formId: number, ipRef: string | null, since: number): Promise<number>;
    /**
     * Envois de cette provenance vers TOUT le site depuis `since`. Le seuil qui
     * l'écarte est celui du site et non d'un formulaire : répartir sa rafale sur
     * vingt canaux ne doit pas la diviser par vingt.
     */
    countSiteSubmissionsSince(siteId: number, ipRef: string, since: number): Promise<number>;
    /** L'instant jusqu'auquel cette provenance est écartée, ou `null`. */
    banUntil(siteId: number, ipRef: string): Promise<number | null>;
    /** Écarte une provenance jusqu'à `until`, ou repousse l'échéance en place. */
    ban(siteId: number, ipRef: string, until: number): Promise<void>;
    /** Retire les mises à l'écart échues. Rendu : lignes supprimées. */
    pruneBans(now: number): Promise<number>;
    /** Le compteur dénormalisé et la date du dernier reçu, en une écriture. */
    touchForm(formId: number, at: number): Promise<void>;
    /** Corrige le compteur dénormalisé après une suppression à l'unité. */
    bumpFormSubmissions(formId: number, delta: number): Promise<void>;
    /**
     * Le libellé d'une question ou d'une réponse, créé au besoin. Jumeau de
     * `resolveLabel`, rattaché au formulaire.
     */
    resolveFormLabel(formId: number, kind: 'field' | 'value', labelRef: string, content: string): Promise<number>;
    /** Le libellé s'il existe déjà, sans le créer : la voie de la décrémentation. */
    findFormLabel(formId: number, kind: 'field' | 'value', labelRef: string): Promise<number | null>;
    /** Combien de valeurs distinctes ce champ a déjà, seau compris. */
    countAnswerValues(formId: number, fieldId: number): Promise<number>;
    /** Combien de questions distinctes ce formulaire indexe déjà. */
    countAnswerFields(formId: number): Promise<number>;
    bumpAnswer(formId: number, fieldId: number, valueId: number, delta: number): Promise<void>;

    // -- lectures -----------------------------------------------------------
    listSubmissions(input: {
        formId: number;
        order: 'recent' | 'oldest';
        cursorTs: number | null;
        cursorId: number | null;
        limit: number;
    }): Promise<AudienceSubmissionWithContextRow[]>;
    findSubmission(submissionId: number): Promise<AudienceSubmissionRow | null>;
    removeSubmission(submissionId: number): Promise<boolean>;
    readAnswers(formId: number): Promise<AudienceAnswerReadRow[]>;
    /** Les retours d'un site : ce que la carte du sommaire montre. */
    feedbackStats(siteId: number, since: number): Promise<AudienceFeedbackStats>;
    /** L'agrégat journalier, qui survit à l'expiration des événements bruts. */
    dailyPoints(siteId: number, sinceDay: number): Promise<AudienceDailyPointRow[]>;
}

export function createFormsRepo(q: SdkQueryable): AudienceFormsRepo {
    async function form(where: string, params: unknown[]): Promise<AudienceFormRow | null> {
        const rows = await q.query<AudienceFormRow>(`SELECT f.* FROM ft_audience_forms f ${where}`, params);
        return rows[0] ?? null;
    }

    return {
        // -- formulaires ----------------------------------------------------
        async listForms(siteId) {
            return q.query<AudienceFormRow>(
                'SELECT * FROM ft_audience_forms WHERE site_id = ? ORDER BY sort_order ASC, id ASC',
                [siteId]
            );
        },
        findForm(formId) {
            return form('WHERE f.id = ?', [formId]);
        },
        findFormByName(siteId, nameRef) {
            return form('WHERE f.site_id = ? AND f.name_ref = ?', [siteId, nameRef]);
        },
        async countForms(siteId) {
            const rows = await q.query<{ n: number }>('SELECT COUNT(*) AS n FROM ft_audience_forms WHERE site_id = ?', [
                siteId
            ]);
            return Number(rows[0]?.n ?? 0);
        },
        async createForm(input) {
            const res = await q.execute(
                `INSERT INTO ft_audience_forms (site_id, name_ref, mode, form_schema, sort_order, content)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [input.siteId, input.nameRef, input.mode, input.formSchema, input.sortOrder, input.content]
            );
            return Number(res.insertId);
        },
        async updateForm(input) {
            // Rouvrir efface le motif de fermeture : le garder ferait raconter à
            // l'écran une rafale à laquelle on a déjà répondu.
            await q.execute(
                `UPDATE ft_audience_forms
                    SET name_ref = ?, content = ?, mode = ?, form_schema = ?, is_open = ?,
                        closed_at = IF(?, NULL, closed_at), closed_reason = IF(?, NULL, closed_reason)
                  WHERE id = ?`,
                [
                    input.nameRef,
                    input.content,
                    input.mode,
                    input.formSchema,
                    input.open ? 1 : 0,
                    input.open ? 1 : 0,
                    input.open ? 1 : 0,
                    input.formId
                ]
            );
        },
        async closeForm(formId, at, reason) {
            await q.execute('UPDATE ft_audience_forms SET is_open = 0, closed_at = ?, closed_reason = ? WHERE id = ?', [
                at,
                reason,
                formId
            ]);
        },
        async removeForm(formId) {
            // Retours, libellés et compteurs partent en CASCADE.
            const res = await q.execute('DELETE FROM ft_audience_forms WHERE id = ?', [formId]);
            return res.affectedRows > 0;
        },
        async clearForm(formId) {
            const res = await q.execute('DELETE FROM ft_audience_submissions WHERE form_id = ?', [formId]);
            // Les compteurs ne décrivent que ce qui est là : on les efface en bloc
            // plutôt que de décrémenter ligne à ligne, ce qui est exact et sans
            // arithmétique. Les libellés partent avec, plus rien ne les cite.
            await q.execute('DELETE FROM ft_audience_answers WHERE form_id = ?', [formId]);
            await q.execute('DELETE FROM ft_audience_form_labels WHERE form_id = ?', [formId]);
            await q.execute('UPDATE ft_audience_forms SET submissions = 0, last_at = NULL WHERE id = ?', [formId]);
            return res.affectedRows;
        },

        // -- réception ------------------------------------------------------
        async insertSubmission(input) {
            const res = await q.execute(
                `INSERT INTO ft_audience_submissions (form_id, site_id, ts, ip_ref, session_id, content)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [input.formId, input.siteId, input.ts, input.ipRef, input.sessionId, input.content]
            );
            return Number(res.insertId);
        },
        async countSiteSubmissionsSince(siteId, ipRef, since) {
            // `idx_ft_audience_submissions_site (site_id, ts)` sert la fenêtre ;
            // `ip_ref` se lit sur les lignes qu'elle rend, peu nombreuses à l'heure.
            const rows = await q.query<{ n: number }>(
                `SELECT COUNT(*) AS n FROM ft_audience_submissions
                  WHERE site_id = ? AND ts >= ? AND ip_ref = ?`,
                [siteId, since, ipRef]
            );
            return Number(rows[0]?.n ?? 0);
        },
        async banUntil(siteId, ipRef) {
            const rows = await q.query<{ until: number }>(
                'SELECT until FROM ft_audience_bans WHERE site_id = ? AND ip_ref = ?',
                [siteId, ipRef]
            );
            return rows[0] ? Number(rows[0].until) : null;
        },
        async ban(siteId, ipRef, until) {
            // `GREATEST` : une rafale qui reprend repousse l'échéance, elle ne la
            // raccourcit jamais.
            await q.execute(
                `INSERT INTO ft_audience_bans (site_id, ip_ref, until) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE until = GREATEST(until, VALUES(until))`,
                [siteId, ipRef, until]
            );
        },
        async pruneBans(now) {
            const res = await q.execute('DELETE FROM ft_audience_bans WHERE until < ?', [now]);
            return res.affectedRows;
        },
        async countSubmissionsSince(formId, ipRef, since) {
            const rows = await q.query<{ n: number }>(
                `SELECT COUNT(*) AS n FROM ft_audience_submissions
                  WHERE form_id = ? AND ts >= ?${ipRef === null ? '' : ' AND ip_ref = ?'}`,
                ipRef === null ? [formId, since] : [formId, since, ipRef]
            );
            return Number(rows[0]?.n ?? 0);
        },
        async touchForm(formId, at) {
            await q.execute(
                `UPDATE ft_audience_forms
                    SET submissions = submissions + 1, last_at = GREATEST(COALESCE(last_at, 0), ?)
                  WHERE id = ?`,
                [at, formId]
            );
        },
        async bumpFormSubmissions(formId, delta) {
            await q.execute('UPDATE ft_audience_forms SET submissions = GREATEST(0, submissions + ?) WHERE id = ?', [
                delta,
                formId
            ]);
        },
        async resolveFormLabel(formId, kind, labelRef, content) {
            const res = await q.execute(
                `INSERT INTO ft_audience_form_labels (form_id, kind, label_ref, content)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
                [formId, kind, labelRef, content]
            );
            return Number(res.insertId);
        },
        async findFormLabel(formId, kind, labelRef) {
            const rows = await q.query<{ id: number }>(
                'SELECT id FROM ft_audience_form_labels WHERE form_id = ? AND kind = ? AND label_ref = ?',
                [formId, kind, labelRef]
            );
            return rows[0] ? Number(rows[0].id) : null;
        },
        async countAnswerValues(formId, fieldId) {
            const rows = await q.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM ft_audience_answers WHERE form_id = ? AND field_id = ?',
                [formId, fieldId]
            );
            return Number(rows[0]?.n ?? 0);
        },
        async countAnswerFields(formId) {
            const rows = await q.query<{ n: number }>(
                "SELECT COUNT(*) AS n FROM ft_audience_form_labels WHERE form_id = ? AND kind = 'field'",
                [formId]
            );
            return Number(rows[0]?.n ?? 0);
        },
        async bumpAnswer(formId, fieldId, valueId, delta) {
            // Une décrémentation ne crée jamais la ligne : l'upsert en posait une à
            // zéro sur un couple inconnu, et ces fantômes comptaient dans
            // `countAnswerValues`, poussant le champ au seau « texte libre » sans
            // qu'aucune réponse ne l'ait justifié.
            if (delta < 0) {
                await q.execute(
                    `UPDATE ft_audience_answers SET hits = GREATEST(0, hits + ?)
                      WHERE form_id = ? AND field_id = ? AND value_id = ?`,
                    [delta, formId, fieldId, valueId]
                );
                return;
            }
            await q.execute(
                `INSERT INTO ft_audience_answers (form_id, field_id, value_id, hits)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE hits = hits + ?`,
                [formId, fieldId, valueId, delta, delta]
            );
        },

        // -- lectures -------------------------------------------------------
        async listSubmissions({ formId, order, cursorTs, cursorId, limit }) {
            const desc = order === 'recent';
            const direction = desc ? 'DESC' : 'ASC';
            const params: unknown[] = [formId];
            // Le curseur porte `(ts, id)` : un OFFSET sauterait ou répéterait une
            // ligne dès qu'un retour arrive pendant la lecture.
            let cursor = '';
            if (cursorTs !== null && cursorId !== null) {
                cursor = desc
                    ? 'AND (b.ts < ? OR (b.ts = ? AND b.id < ?))'
                    : 'AND (b.ts > ? OR (b.ts = ? AND b.id > ?))';
                params.push(cursorTs, cursorTs, cursorId);
            }
            params.push(limit);

            // Le contexte de visite est joint ici plutôt que relu par ligne : quatre
            // LEFT JOIN sur des clés primaires coûtent moins qu'un aller-retour par
            // retour affiché, et les blobs se déchiffrent ensuite en mémoïsant.
            return q.query<AudienceSubmissionWithContextRow>(
                `SELECT b.*,
                        lp.content AS entry_path_content,
                        lr.content AS referrer_content,
                        lb.content AS browser_content,
                        ld.content AS device_content
                   FROM ft_audience_submissions b
                   LEFT JOIN audience_sessions v ON v.id = b.session_id
                   LEFT JOIN audience_labels lp ON lp.id = v.entry_path_id
                   LEFT JOIN audience_labels lr ON lr.id = v.referrer_id
                   LEFT JOIN audience_labels lb ON lb.id = v.browser_id
                   LEFT JOIN audience_labels ld ON ld.id = v.device_id
                  WHERE b.form_id = ? ${cursor}
                  ORDER BY b.ts ${direction}, b.id ${direction}
                  LIMIT ?`,
                params
            );
        },
        async findSubmission(submissionId) {
            const rows = await q.query<AudienceSubmissionRow>('SELECT * FROM ft_audience_submissions WHERE id = ?', [
                submissionId
            ]);
            return rows[0] ?? null;
        },
        async removeSubmission(submissionId) {
            const res = await q.execute('DELETE FROM ft_audience_submissions WHERE id = ?', [submissionId]);
            return res.affectedRows > 0;
        },
        async readAnswers(formId) {
            // Les questions dans leur ordre d'apparition (les libellés sont créés à la
            // volée, donc leur identifiant croît avec elle), les réponses par
            // fréquence. Le seau (`value_id = 0`) n'a pas de libellé, d'où le LEFT.
            return q.query<AudienceAnswerReadRow>(
                `SELECT a.field_id, f.content AS field_content, a.value_id, v.content AS value_content, a.hits
                   FROM ft_audience_answers a
                   JOIN ft_audience_form_labels f ON f.id = a.field_id
                   LEFT JOIN ft_audience_form_labels v ON v.id = a.value_id
                  WHERE a.form_id = ? AND a.hits > 0
                  ORDER BY a.field_id ASC, a.hits DESC, a.value_id ASC
                  LIMIT ?`,
                [formId, AUDIENCE_ANSWER_ROWS_MAX]
            );
        },
        async feedbackStats(siteId, since) {
            const rows = await q.query<{ forms: number; submissions: number; last7d: number; last_at: number | null }>(
                `SELECT (SELECT COUNT(*) FROM ft_audience_forms WHERE site_id = ?) AS forms,
                        COALESCE(SUM(f.submissions), 0) AS submissions,
                        COALESCE(MAX(f.last_at), NULL) AS last_at,
                        (SELECT COUNT(*) FROM ft_audience_submissions
                          WHERE site_id = ? AND ts >= ?) AS last7d
                   FROM ft_audience_forms f
                  WHERE f.site_id = ?`,
                [siteId, siteId, since, siteId]
            );
            const row = rows[0];
            return {
                forms: Number(row?.forms ?? 0),
                submissions: Number(row?.submissions ?? 0),
                last7d: Number(row?.last7d ?? 0),
                lastAt: row?.last_at === null || row?.last_at === undefined ? null : Number(row.last_at)
            };
        },
        async dailyPoints(siteId, sinceDay) {
            const rows = await q.query<AudienceDailyPointRow>(
                'SELECT day, views FROM audience_daily WHERE site_id = ? AND day >= ? ORDER BY day ASC',
                [siteId, sinceDay]
            );
            return rows.map((row) => ({ day: Number(row.day), views: Number(row.views) }));
        }
    };
}
