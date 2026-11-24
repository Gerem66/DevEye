import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestContext } from '@deveye/types/sdk/testing';
import fc from 'fast-check';

import type { FinanceTransactionRow } from '../contracts/domain';
import type { StatementLineInput } from '../contracts/statement';
import { fitsLine, lineIdentities, vatOfGross } from './reconcile';

/** Les calculs du rapprochement, sur des relevés et des montants quelconques. */

const line: fc.Arbitrary<StatementLineInput> = fc.record({
    date: fc.constantFrom('2026-11-23', '2026-11-24'),
    direction: fc.constantFrom('in', 'out'),
    amount: fc.integer({ min: 1, max: 3 }),
    // Peu de libellés, et qui se confondent une fois normalisés ou recollés au mémo.
    label: fc.constantFrom('CB CAFE', 'cb  café', 'CB', 'a|b', 'a', ''),
    memo: fc.constantFrom('', 'CAFE', 'b', '|b|0'),
    fitid: fc.option(fc.constantFrom('A1', 'A2'), { nil: null, freq: 4 })
});

describe('lineIdentities', () => {
    const io = createTestContext();

    it('donne à chaque ligne sans identité de banque une empreinte qui n’est celle d’aucune autre', () => {
        fc.assert(
            fc.property(fc.array(line, { maxLength: 30 }), fc.integer({ min: 1, max: 3 }), (lines, accountId) => {
                const identities = lineIdentities(io, accountId, lines);
                assert.equal(identities.length, lines.length);
                lines.forEach((entry, index) => {
                    if (entry.fitid !== null) assert.equal(identities[index], `ofx:${entry.fitid}`);
                    else assert.match(identities[index], /^csv:[0-9a-f]{40}$/);
                });
                const printed = identities.filter((_, index) => lines[index].fitid === null);
                assert.equal(new Set(printed).size, printed.length);
            })
        );
    });

    it('rend les mêmes empreintes au second import, et d’autres pour un autre compte', () => {
        fc.assert(
            fc.property(fc.array(line, { minLength: 1, maxLength: 30 }), (lines) => {
                const first = lineIdentities(io, 1, lines);
                assert.deepEqual(lineIdentities(io, 1, structuredClone(lines)), first);
                const elsewhere = lineIdentities(io, 2, lines);
                lines.forEach((entry, index) => {
                    if (entry.fitid === null) assert.ok(!first.includes(elsewhere[index]));
                });
            })
        );
    });

    it('une ligne ajoutée en fin de relevé ne change l’empreinte d’aucune de celles qui la précèdent', () => {
        fc.assert(
            fc.property(fc.array(line, { maxLength: 30 }), line, (lines, added) => {
                assert.deepEqual(
                    lineIdentities(io, 1, [...lines, added]).slice(0, lines.length),
                    lineIdentities(io, 1, lines)
                );
            })
        );
    });
});

describe('vatOfGross', () => {
    it('rend la part de TVA arrondie au centime, entre zéro et le montant', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: 10_000_000_000 }),
                fc.integer({ min: 0, max: 10_000 }),
                (gross, rateBp) => {
                    const vat = vatOfGross(gross, rateBp);
                    assert.ok(Number.isSafeInteger(vat) && vat >= 0 && vat <= gross);
                    // L'écart à la valeur exacte, gross × taux / (10 000 + taux), ne dépasse pas un demi-centime.
                    const divisor = BigInt(10_000 + rateBp);
                    const gap = BigInt(vat) * divisor - BigInt(gross) * BigInt(rateBp);
                    assert.ok(2n * (gap < 0n ? -gap : gap) <= divisor, `${gross} à ${rateBp} : ${vat}`);
                }
            )
        );
    });
});

describe('fitsLine', () => {
    const transaction = fc.record({
        kind: fc.constantFrom('income', 'expense', 'transfer'),
        amount: fc.integer({ min: 1, max: 3 }),
        account_id: fc.integer({ min: 1, max: 3 }),
        transfer_account_id: fc.option(fc.integer({ min: 1, max: 3 }), { nil: null })
    }) as fc.Arbitrary<FinanceTransactionRow>;
    const target = fc.record({
        account_id: fc.integer({ min: 1, max: 3 }),
        direction: fc.constantFrom('in', 'out'),
        amount: fc.integer({ min: 1, max: 3 })
    }) as fc.Arbitrary<Parameters<typeof fitsLine>[1]>;

    it('ne rattache une opération qu’à une ligne de même montant, sur un compte qu’elle touche, dans son sens', () => {
        fc.assert(
            fc.property(transaction, target, (t, entry) => {
                if (!fitsLine(t, entry)) return;
                assert.equal(t.amount, entry.amount);
                assert.ok(t.account_id === entry.account_id || t.transfer_account_id === entry.account_id);
                if (t.kind === 'income') assert.equal(entry.direction, 'in');
                if (t.kind === 'expense') assert.equal(entry.direction, 'out');
            })
        );
    });

    it('un virement confirme une sortie sur son compte de départ et une entrée sur celui d’arrivée', () => {
        fc.assert(
            fc.property(transaction, (t) => {
                fc.pre(
                    t.kind === 'transfer' && t.transfer_account_id !== null && t.transfer_account_id !== t.account_id
                );
                assert.ok(fitsLine(t, { account_id: t.account_id, direction: 'out', amount: t.amount }));
                assert.ok(
                    fitsLine(t, { account_id: t.transfer_account_id as number, direction: 'in', amount: t.amount })
                );
                assert.ok(!fitsLine(t, { account_id: t.account_id, direction: 'in', amount: t.amount }));
                assert.ok(
                    !fitsLine(t, { account_id: t.transfer_account_id as number, direction: 'out', amount: t.amount })
                );
            })
        );
    });
});
