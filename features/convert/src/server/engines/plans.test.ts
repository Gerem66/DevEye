import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sourceOf, targetOf, type ConvertKind } from '../../contracts/catalogue';
import { resolveOptions, type OptionValues } from '../../contracts/options';
import { env } from '../env';
import { ConvertFailure } from '../spawn';
import { jobPaths } from '../storage';
import { audioPlan, gifPlan, progressOf, videoPlan } from './ffmpeg';
import { imageArgs } from './image';
import type { InputProbe } from './types';

/**
 * Les arguments des outils, comparés en entier : c'est la meilleure garde contre
 * une régression d'injection, et contre un réglage qui cesserait d'arriver
 * jusqu'à l'outil.
 */

env.CONVERT_STORAGE_DIR = '/data/convert';
env.CONVERT_THREADS = 3;

const PROBE: InputProbe = {
    bytes: 50_000_000,
    durationMs: 60_000,
    width: 1920,
    height: 1080,
    fps: 30,
    audioKbps: 256,
    reader: 'mov',
    hasAudio: true,
    pages: null
};

function plan(kind: ConvertKind, sourceId: string, targetId: string, values: OptionValues, probe: InputProbe = PROBE) {
    const source = sourceOf(kind, sourceId);
    const target = targetOf(kind, sourceId, targetId);
    assert.ok(source && target);
    return { source, target, options: resolveOptions(target.options, values), probe, paths: jobPaths(7, 42) };
}

const HEAD = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];
const IN = '/data/convert/ws-7/42/in.bin';
const OUT = '/data/convert/ws-7/42/out.part';

describe('plan vidéo', () => {
    it('compose une conversion en qualité, réglage par réglage', () => {
        const { passes, seconds } = videoPlan(
            plan('video', 'mp4', 'mp4', {
                quality: 50,
                height: '720',
                fps: '24',
                speed: 'fast',
                audioBitrate: 96,
                trimStart: 10,
                trimEnd: 40,
                crop: { top: 140, right: 0, bottom: 140, left: 0 }
            })
        );
        assert.equal(seconds, 30);
        assert.deepEqual(passes, [
            [
                ...HEAD,
                '-protocol_whitelist',
                'file',
                '-f',
                'mov',
                '-ss',
                '10',
                '-t',
                '30',
                '-i',
                IN,
                '-map',
                '0:v:0',
                '-sn',
                '-dn',
                '-vf',
                'crop=1920:800:0:140,scale=1728:720,fps=24',
                '-c:v',
                'libx264',
                '-crf',
                '27',
                '-preset',
                'veryfast',
                '-map',
                '0:a:0',
                '-c:a',
                'aac',
                '-b:a',
                '96000',
                '-map_metadata',
                '-1',
                '-map_chapters',
                '-1',
                '-threads',
                '3',
                '-max_muxing_queue_size',
                '1024',
                '-pix_fmt',
                'yuv420p',
                '-movflags',
                '+faststart',
                '-f',
                'mp4',
                OUT
            ]
        ]);
    });

    it('n’agrandit pas, et coupe le son quand il n’y en a pas', () => {
        const [args] = videoPlan(
            plan('video', 'mp4', 'webm', { height: '2160' }, { ...PROBE, hasAudio: false })
        ).passes;
        assert.equal(args.includes('-vf'), false);
        assert.ok(args.includes('-an'));
        assert.deepEqual(args.slice(args.indexOf('-crf'), args.indexOf('-crf') + 4), ['-crf', '30', '-b:v', '0']);
    });

    it('vise une taille en deux passes, le journal dans le dossier du travail', () => {
        const { passes } = videoPlan(
            plan('video', 'mp4', 'mp4', { mode: 'size', targetBytes: 20_000_000, height: '480' })
        );
        assert.equal(passes.length, 2);
        const [first, second] = passes;
        assert.deepEqual(first.slice(-6), ['-pass', '1', '-an', '-f', 'null', '/dev/null']);
        assert.equal(first[first.indexOf('-passlogfile') + 1], '/data/convert/ws-7/42/work/pass');
        assert.equal(second.at(-1), OUT);
        const bitrate = Number(second[second.indexOf('-b:v') + 1]);
        assert.ok(Math.abs(((bitrate + 128_000) * 60 * 1.015) / 8 - 20_000_000) < 1000);
    });

    it('refuse une taille intenable, et cite le plancher', () => {
        assert.throws(
            () => videoPlan(plan('video', 'mp4', 'mp4', { mode: 'size', targetBytes: 1_000_000 })),
            (e: unknown) =>
                e instanceof ConvertFailure && e.code === 'target_too_small' && /minimum regardable/.test(e.message)
        );
    });

    it('refuse un fichier sans image', () => {
        assert.throws(
            () => videoPlan(plan('video', 'mp4', 'mp4', {}, { ...PROBE, width: null, height: null })),
            (e: unknown) => e instanceof ConvertFailure && e.code === 'unsupported'
        );
    });
});

describe('plans audio et GIF', () => {
    it('compose une piste allégée, mono, au volume égalisé', () => {
        const [args] = audioPlan(
            plan(
                'audio',
                'wav',
                'mp3',
                { keepBitrate: false, bitrate: 128, channels: '1', sampleRate: '44100', normalize: true },
                { ...PROBE, reader: 'wav' }
            )
        ).passes;
        assert.deepEqual(args, [
            ...HEAD,
            '-protocol_whitelist',
            'file',
            '-f',
            'wav',
            '-i',
            IN,
            '-map',
            '0:a:0',
            '-vn',
            '-sn',
            '-dn',
            '-c:a',
            'libmp3lame',
            '-b:a',
            '128000',
            '-ar',
            '44100',
            '-ac',
            '1',
            '-af',
            'loudnorm=I=-16:TP=-1.5:LRA=11',
            '-threads',
            '3',
            '-f',
            'mp3',
            OUT
        ]);
    });

    it('garde par défaut le débit que le fichier avait, dans ce que le format admet', () => {
        const bitrateOf = (audioKbps: number | null): string => {
            const [args] = audioPlan(
                plan('audio', 'mp3', 'mp3', { bitrate: 96 }, { ...PROBE, reader: 'mp3', audioKbps })
            ).passes;
            return args[args.indexOf('-b:a') + 1];
        };
        assert.equal(bitrateOf(130), '130000');
        assert.equal(bitrateOf(1411), '320000', 'un son sans perte plafonne au plus haut débit du format');
        assert.equal(bitrateOf(24), '64000');
        // Le curseur, masqué tant que la qualité d'origine est gardée, est revenu à son défaut.
        assert.equal(bitrateOf(null), '192000', 'illisible : le débit par défaut du format');
    });

    it('ne pose pas de débit sur un format sans perte', () => {
        const [args] = audioPlan(plan('audio', 'mp3', 'flac', {}, { ...PROBE, reader: 'mp3' })).passes;
        assert.equal(args.includes('-b:a'), false);
    });

    it('refuse de tirer le son d’un fichier muet', () => {
        assert.throws(
            () => audioPlan(plan('video', 'mp4', 'mp3', {}, { ...PROBE, hasAudio: false })),
            (e: unknown) => e instanceof ConvertFailure && e.code === 'unsupported'
        );
    });

    it('calcule la palette d’un GIF sur la vidéo elle-même', () => {
        const [args] = gifPlan(plan('video', 'mp4', 'gif', { gifWidth: 320, gifFps: 10 })).passes;
        const filter = args[args.indexOf('-filter_complex') + 1];
        assert.match(filter, /^\[0:v:0\]fps=10,scale=320:-2:flags=lanczos,split/);
        assert.match(filter, /palettegen.*paletteuse/);
    });
});

describe('arguments d’image', () => {
    const IMAGE = { ...PROBE, durationMs: null, fps: null, reader: 'PNG', hasAudio: false, width: 4000, height: 3000 };

    it('impose le codeur, redresse avant tout, aplatit la transparence vers un format qui n’en a pas', () => {
        const args = imageArgs(
            plan('image', 'png', 'jpg', { quality: 70, resize: { width: 2000, height: null, keepRatio: true } }, IMAGE)
        );
        assert.deepEqual(args.slice(args.indexOf(`PNG:${IN}[0]`)), [
            `PNG:${IN}[0]`,
            '-auto-orient',
            '-resize',
            '2000x1500!',
            '+profile',
            '!icc,*',
            '-set',
            'comment',
            '',
            '-background',
            'white',
            '-alpha',
            'remove',
            '-alpha',
            'off',
            '-quality',
            '70',
            `JPEG:${OUT}`
        ]);
        assert.deepEqual(args.slice(0, 2), ['-limit', 'memory'], 'les limites passent avant la lecture');
    });

    it('garde les informations cachées quand on le demande, et la transparence quand le format la porte', () => {
        const args = imageArgs(plan('image', 'png', 'webp', { stripMetadata: false }, IMAGE));
        assert.equal(args.includes('+profile'), false);
        assert.equal(args.includes('-alpha'), false);
    });
});

describe('avancement', () => {
    it('lit le temps écoulé, en millièmes de la durée gardée', () => {
        assert.equal(progressOf('out_time_us=15000000', 60), 250);
        assert.equal(progressOf('out_time_ms=90000000', 60), 1000, 'borné');
        assert.equal(progressOf('speed=1.2x', 60), null);
        assert.equal(progressOf('out_time_us=15000000', 0), null, 'durée inconnue');
    });
});
