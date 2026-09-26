import {
    financeImportMapping,
    financeRuleList,
    financeRuleRemove,
    financeRuleSave,
    financeStatementImport,
    financeStatementList,
    financeStatementResolve
} from '../../contracts/commands';
import {
    csvMappingSchema,
    type FinanceRule,
    type FinanceRuleRow,
    type FinanceStatementLineRow,
    type StatementLine,
    type StatementProposal
} from '../../contracts/statement';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    decryptJson,
    encryptJson,
    financeCipher,
    invoicingLedger,
    isDuplicate,
    readConfig,
    WRITE,
    type Ctx,
    type StoredEntry
} from '../_shared';
import {
    fitsLine,
    lineIdentities,
    proposalsFor,
    reconcileAccount,
    reconcilePending,
    vatOfGross,
    type StoredLine,
    type StoredRule
} from '../reconcile';
import { catchUp } from '../sources';
import { postOccurrence } from './recurring';

/**
 * Les relevés bancaires : l'import, la liste de ce qui attend, et les gestes qui
 * rapprochent une ligne. Le relevé est lu dans le navigateur ; ici arrivent des
 * lignes déjà normalisées.
 */

const mappingKey = (accountId: number) => `import:${accountId}`;

/** Une ligne de relevé à l'écran, avec ce qu'elle pourrait être quand elle attend. */
async function toLine(ctx: Ctx, row: FinanceStatementLineRow, proposals: StatementProposal[]): Promise<StatementLine> {
    const stored = await decryptJson<StoredLine>(financeCipher(ctx), row.content);
    return {
        id: row.id,
        accountId: row.account_id,
        date: row.date,
        direction: row.direction,
        amount: Number(row.amount),
        label: stored?.label ?? '',
        memo: stored?.memo ?? '',
        status: row.transaction_id !== null ? 'matched' : row.ignored === 1 ? 'ignored' : 'pending',
        transactionId: row.transaction_id,
        proposals
    };
}

async function toRule(ctx: Ctx, row: FinanceRuleRow): Promise<FinanceRule> {
    const stored = await decryptJson<StoredRule>(financeCipher(ctx), row.content);
    return {
        id: row.id,
        contains: stored?.contains ?? '',
        direction: row.direction,
        categoryId: row.category_id,
        vatRateBp: row.vat_rate_bp,
        hits: Number(row.hits)
    };
}

export const financeStatementImportFeature = defineSdkFeature({
    ...financeStatementImport,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        // Les échéances dues et les règlements de Facturation d'abord : ce sont eux que le relevé confirme.
        await catchUp(ctx);
        const account = await ctx.repo.findAccount(input.accountId, ctx.workspaceId, input.lines[0].date);
        if (!account) throw new FeatureError('not_found', 'Compte introuvable');
        if (account.archived === 1) {
            throw new FeatureError('validation', 'Un compte archivé ne reçoit plus rien : désarchivez-le d’abord.');
        }
        const emptyBefore = Number(account.transaction_count) === 0;
        const dates = input.lines.map((line) => line.date).sort();
        const importId = await ctx.repo.createImport(ctx.workspaceId, {
            accountId: input.accountId,
            format: input.format,
            firstDate: dates[0],
            lastDate: dates[dates.length - 1],
            lineCount: input.lines.length,
            newCount: 0,
            closingBalance: input.closing?.balance ?? null,
            closingDate: input.closing?.date ?? null
        });

        const cipher = financeCipher(ctx);
        const identities = lineIdentities(ctx, input.accountId, input.lines);
        let added = 0;
        for (let i = 0; i < input.lines.length; i++) {
            const line = input.lines[i];
            const payload: StoredLine = { label: line.label, memo: line.memo };
            const id = await ctx.repo.insertLine(ctx.workspaceId, {
                accountId: input.accountId,
                importId,
                externalId: identities[i],
                date: line.date,
                direction: line.direction,
                amount: line.amount,
                content: await encryptJson(cipher, payload)
            });
            if (id !== null) added += 1;
        }
        await ctx.repo.setImportCounts(importId, ctx.workspaceId, input.lines.length, added);
        if (input.mapping !== null)
            await ctx.store.putJson(mappingKey(input.accountId), csvMappingSchema, input.mapping);

        const outcome = await reconcileAccount(ctx, input.accountId);
        const pending = await ctx.repo.countPendingLines(ctx.workspaceId, input.accountId);

        // Sur un compte encore vide, le solde de départ que le relevé implique :
        // ce que la banque annonce, moins les lignes qui y mènent.
        let opening = null;
        if (emptyBefore && input.closing !== null) {
            const closing = input.closing;
            const net = input.lines
                .filter((line) => line.date <= closing.date)
                .reduce((sum, line) => sum + (line.direction === 'in' ? line.amount : -line.amount), 0);
            opening = { balance: closing.balance - net, date: dates[0] };
        }

        ctx.audit({
            action: 'finance.statementImport',
            description: 'Relevé bancaire importé',
            metadata: { accountId: input.accountId, format: input.format, received: input.lines.length, added }
        });
        return {
            result: {
                received: input.lines.length,
                added,
                duplicates: input.lines.length - added,
                matched: outcome.matched,
                ruled: outcome.ruled,
                pending,
                opening
            }
        };
    }
});

export const financeImportMappingFeature = defineSdkFeature({
    ...financeImportMapping,
    handler: async (ctx: Ctx, input) => ({
        mapping: await ctx.store.getJson(mappingKey(input.accountId), csvMappingSchema)
    })
});

export const financeStatementListFeature = defineSdkFeature({
    ...financeStatementList,
    handler: async (ctx: Ctx, input) => {
        await catchUp(ctx);
        const rows = await ctx.repo.listLines(
            ctx.workspaceId,
            {
                pendingOnly: input.status === 'pending',
                ...(input.accountId !== undefined ? { accountId: input.accountId } : {})
            },
            input.limit ?? 200
        );
        const config = await readConfig(ctx);
        const ledger = invoicingLedger(ctx);
        const receivables =
            ledger === null
                ? []
                : (await ledger.receivables(ctx.workspaceId).catch(() => [])).filter(
                      (r) => r.currency === config.currency
                  );
        const proposals = await proposalsFor(ctx, rows, receivables, config.invoicing.accountId);
        const lines = await Promise.all(rows.map((row) => toLine(ctx, row, proposals.get(row.id) ?? [])));

        const closings = await ctx.repo.latestClosings(ctx.workspaceId);
        const banks = [];
        for (const closing of closings) {
            const account = await ctx.repo.findAccount(closing.account_id, ctx.workspaceId, closing.closing_date);
            if (account === null) continue;
            banks.push({
                accountId: closing.account_id,
                date: closing.closing_date,
                bank: Number(closing.closing_balance),
                book: Number(account.cleared)
            });
        }
        return { lines, pendingCount: await ctx.repo.countPendingLines(ctx.workspaceId), banks };
    }
});

export const financeStatementResolveFeature = defineSdkFeature({
    ...financeStatementResolve,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const lines = await ctx.repo.findLines(ctx.workspaceId, input.lineIds);
        if (lines.length !== new Set(input.lineIds).size)
            throw new FeatureError('not_found', 'Ligne de relevé introuvable');
        const action = input.action;
        const single = () => {
            if (lines.length !== 1)
                throw new FeatureError('validation', 'Ce geste ne vaut que pour une ligne à la fois.');
            return lines[0];
        };
        const pending = (line: FinanceStatementLineRow) => {
            if (line.transaction_id !== null) throw new FeatureError('conflict', 'Cette ligne est déjà rapprochée.');
        };
        const cipher = financeCipher(ctx);
        let resolved = 0;

        switch (action.kind) {
            case 'link': {
                const line = single();
                pending(line);
                const t = await ctx.repo.findTransaction(action.transactionId, ctx.workspaceId);
                if (!t) throw new FeatureError('not_found', 'Opération introuvable');
                if (!fitsLine(t, line)) {
                    throw new FeatureError(
                        'validation',
                        'Cette opération n’a pas le compte, le sens ou le montant de la ligne.'
                    );
                }
                const taken = await ctx.repo.linkedLines(ctx.workspaceId, t.id);
                if (taken.some((other) => other.account_id === line.account_id)) {
                    throw new FeatureError('conflict', 'Cette opération confirme déjà une autre ligne du relevé.');
                }
                try {
                    await ctx.repo.linkLine(line.id, ctx.workspaceId, t.id);
                } catch (error) {
                    if (!isDuplicate(error)) throw error;
                    throw new FeatureError('conflict', 'Cette opération confirme déjà une autre ligne du relevé.');
                }
                await ctx.repo.setCleared(ctx.workspaceId, [t.id], true);
                resolved = 1;
                break;
            }
            case 'create': {
                const category =
                    action.categoryId === null ? null : await ctx.repo.findCategory(action.categoryId, ctx.workspaceId);
                if (action.categoryId !== null && !category)
                    throw new FeatureError('not_found', 'Catégorie introuvable');
                const open = lines.filter((line) => line.transaction_id === null);
                if (new Set(open.map((line) => line.direction)).size > 1 && category) {
                    throw new FeatureError(
                        'validation',
                        'Des entrées et des sorties ne se rangent pas dans la même catégorie.'
                    );
                }
                const direction = open[0]?.direction;
                if (
                    category &&
                    direction !== undefined &&
                    category.flow !== (direction === 'in' ? 'income' : 'expense')
                ) {
                    throw new FeatureError(
                        'validation',
                        direction === 'in'
                            ? 'Une ligne qui entre se range dans une catégorie de recettes.'
                            : 'Une ligne qui sort se range dans une catégorie de dépenses.'
                    );
                }
                // Une TVA ne se récupère qu'au régime réel.
                const { vatEnabled } = await readConfig(ctx);
                const rateBp = vatEnabled ? action.vatRateBp : null;
                for (const line of open) {
                    const flow = line.direction === 'in' ? 'income' : 'expense';
                    const stored = await decryptJson<StoredLine>(cipher, line.content);
                    const payload: StoredEntry = {
                        label: action.label?.trim() || (stored?.label ?? ''),
                        counterparty: action.counterparty.trim(),
                        note: ''
                    };
                    const id = await ctx.repo.createTransaction(ctx.workspaceId, {
                        accountId: line.account_id,
                        transferAccountId: null,
                        categoryId: action.categoryId,
                        recurringId: null,
                        source: null,
                        sourceRef: null,
                        kind: flow,
                        amount: Number(line.amount),
                        vatAmount: rateBp === null || rateBp === 0 ? null : vatOfGross(Number(line.amount), rateBp),
                        date: line.date,
                        cleared: true,
                        content: await encryptJson(cipher, payload)
                    });
                    await ctx.repo.linkLine(line.id, ctx.workspaceId, id);
                    resolved += 1;
                }
                if (action.rule !== null && action.categoryId !== null && direction !== undefined) {
                    const rule: StoredRule = { contains: action.rule.contains };
                    await ctx.repo.createRule(ctx.workspaceId, {
                        direction,
                        categoryId: action.categoryId,
                        vatRateBp: action.vatRateBp,
                        content: await encryptJson(cipher, rule)
                    });
                    // La règle range aussitôt les autres lignes en attente qu'elle reconnaît.
                    await reconcilePending(ctx);
                }
                break;
            }
            case 'transfer': {
                const line = single();
                pending(line);
                if (action.accountId === line.account_id) {
                    throw new FeatureError('validation', 'Un virement va vers un autre compte du livre.');
                }
                const other = await ctx.repo.findAccountPlain(action.accountId, ctx.workspaceId);
                if (!other) throw new FeatureError('not_found', 'Compte introuvable');
                const stored = await decryptJson<StoredLine>(cipher, line.content);
                const out = line.direction === 'out';
                const payload: StoredEntry = { label: stored?.label ?? '', counterparty: '', note: '' };
                const id = await ctx.repo.createTransaction(ctx.workspaceId, {
                    accountId: out ? line.account_id : action.accountId,
                    transferAccountId: out ? action.accountId : line.account_id,
                    categoryId: null,
                    recurringId: null,
                    source: null,
                    sourceRef: null,
                    kind: 'transfer',
                    amount: Number(line.amount),
                    vatAmount: null,
                    date: line.date,
                    cleared: true,
                    content: await encryptJson(cipher, payload)
                });
                await ctx.repo.linkLine(line.id, ctx.workspaceId, id);
                // L'autre moitié du virement, si le relevé de l'autre compte est déjà là.
                await reconcileAccount(ctx, action.accountId);
                resolved = 1;
                break;
            }
            case 'post': {
                const line = single();
                pending(line);
                const row = await ctx.repo.findRecurring(action.recurringId, ctx.workspaceId);
                if (!row) throw new FeatureError('not_found', 'Échéance introuvable');
                if (
                    row.account_id !== line.account_id ||
                    row.kind !== (line.direction === 'in' ? 'income' : 'expense')
                ) {
                    throw new FeatureError('validation', 'Cette échéance n’a pas le compte ou le sens de la ligne.');
                }
                const id = await postOccurrence(ctx, row, Number(line.amount), true);
                await ctx.repo.linkLine(line.id, ctx.workspaceId, id);
                resolved = 1;
                break;
            }
            case 'ignore':
            case 'restore': {
                const open = lines.filter((line) => line.transaction_id === null).map((line) => line.id);
                await ctx.repo.setLineIgnored(open, ctx.workspaceId, action.kind === 'ignore');
                resolved = open.length;
                break;
            }
        }

        if (action.kind !== 'ignore' && action.kind !== 'restore') {
            ctx.audit({
                action: 'finance.statementResolve',
                description: 'Lignes de relevé rapprochées',
                metadata: { kind: action.kind, lines: resolved }
            });
        }
        return { resolved, pending: await ctx.repo.countPendingLines(ctx.workspaceId) };
    }
});

export const financeRuleListFeature = defineSdkFeature({
    ...financeRuleList,
    handler: async (ctx: Ctx) => {
        const rows = await ctx.repo.listRules(ctx.workspaceId);
        return { rules: await Promise.all(rows.map((row) => toRule(ctx, row))) };
    }
});

export const financeRuleSaveFeature = defineSdkFeature({
    ...financeRuleSave,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const category = await ctx.repo.findCategory(input.rule.categoryId, ctx.workspaceId);
        if (!category) throw new FeatureError('not_found', 'Catégorie introuvable');
        const flow = input.rule.direction === null ? null : input.rule.direction === 'in' ? 'income' : 'expense';
        if (flow !== null && category.flow !== flow) {
            throw new FeatureError('validation', 'La catégorie ne va pas au sens choisi.');
        }
        const stored: StoredRule = { contains: input.rule.contains.trim() };
        const fields = {
            direction: input.rule.direction,
            categoryId: input.rule.categoryId,
            vatRateBp: input.rule.vatRateBp,
            content: await encryptJson(financeCipher(ctx), stored)
        };
        let id = input.id;
        if (id === null) id = await ctx.repo.createRule(ctx.workspaceId, fields);
        else if (!(await ctx.repo.updateRule(id, ctx.workspaceId, fields))) {
            throw new FeatureError('not_found', 'Règle introuvable');
        }
        await reconcilePending(ctx);
        const row = await ctx.repo.findRule(id, ctx.workspaceId);
        if (!row) throw new FeatureError('internal', 'Règle introuvable après enregistrement');
        return { rule: await toRule(ctx, row) };
    }
});

export const financeRuleRemoveFeature = defineSdkFeature({
    ...financeRuleRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        if (!(await ctx.repo.deleteRule(input.id, ctx.workspaceId)))
            throw new FeatureError('not_found', 'Règle introuvable');
        return { id: input.id };
    }
});
