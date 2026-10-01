import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyLine, classifyLog, splitLines, stripAnsi } from './classify';

describe('stripAnsi et splitLines', () => {
    it('retire les couleurs et les déplacements de curseur', () => {
        assert.equal(stripAnsi('\u001b[32mok\u001b[0m \u001b[1;31mKO\u001b[0m \u001b[2K'), 'ok KO ');
    });

    it('résout les retours chariot : le dernier état d’une ligne réécrite', () => {
        assert.deepEqual(splitLines('a\r\nb\n10 %\r50 %\r100 %\nfin'), ['a', 'b', '100 %', 'fin']);
    });

    it('ne compte pas la ligne vide d’un retour final', () => {
        assert.equal(classifyLog('a\nb\n').length, 2);
        assert.equal(classifyLog('').length, 0);
    });
});

describe('classifyLine : la sorte d’une ligne', () => {
    const kind = (text: string) => classifyLine(text).kind;

    it('reconnaît les étapes', () => {
        assert.equal(kind('=== build ==='), 'step');
        assert.equal(kind('##[group]Run npm ci'), 'step');
        assert.equal(kind('#12 [stage-1 3/7] RUN npm ci'), 'step');
        assert.equal(kind('Step 3/10 : COPY . .'), 'step');
    });

    it('distingue le début d’un groupe de sa fin', () => {
        assert.equal(kind('##[endgroup]'), 'muted');
        assert.equal(kind('##[debug]Evaluating condition'), 'muted');
        assert.equal(kind('   '), 'muted');
    });

    it('reconnaît les erreurs, les avertissements et les succès', () => {
        assert.equal(kind('##[error]Process completed with exit code 1.'), 'error');
        assert.equal(kind('npm ERR! code ELIFECYCLE'), 'error');
        assert.equal(kind('Error: connect ECONNREFUSED'), 'error');
        assert.equal(kind('Build failed in 2.3s'), 'error');
        assert.equal(kind('##[warning]Node 16 is deprecated'), 'warning');
        assert.equal(kind('npm warn deprecated inflight@1.0.6'), 'warning');
        assert.equal(kind('#12 DONE 0.3s'), 'success');
        assert.equal(kind('✓ 42 tests passed'), 'success');
        assert.equal(kind('Deployment completed'), 'success');
        assert.equal(kind('Copying files'), 'plain');
    });

    it('une étape qui parle d’erreur reste une étape', () => {
        assert.equal(kind('##[group]Run handle errors'), 'step');
    });

    it('juge la ligne sans son horodatage de tête', () => {
        assert.equal(kind('2026-10-01T12:00:00.123Z ##[error]boom'), 'error');
        assert.equal(kind('[12:00:03] #4 [build 2/5] RUN make'), 'step');
    });
});

describe('classifyLine : les jetons', () => {
    it('détache l’horodatage, l’identifiant d’étape et les durées', () => {
        const { tokens } = classifyLine('2026-10-01T12:00:00Z #12 DONE 0.3s');
        assert.deepEqual(tokens, [
            { kind: 'time', text: '2026-10-01T12:00:00Z' },
            { kind: 'text', text: ' ' },
            { kind: 'id', text: '#12' },
            { kind: 'text', text: ' DONE ' },
            { kind: 'duration', text: '0.3s' }
        ]);
    });

    it('rend le texte intact quand rien ne se détache', () => {
        const line = 'Copying files from k8s to the server';
        assert.deepEqual(classifyLine(line).tokens, [{ kind: 'text', text: line }]);
        assert.equal(
            classifyLine(line)
                .tokens.map((t) => t.text)
                .join(''),
            line
        );
    });

    it('les jetons recomposent toujours la ligne', () => {
        for (const line of ['[12:00:03] step took 12ms then 1.5s', '#3 0.512 npm warn x', '']) {
            assert.equal(
                classifyLine(line)
                    .tokens.map((t) => t.text)
                    .join(''),
                line
            );
        }
    });
});
