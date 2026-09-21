import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { estimateJpegQuality } from './jpegQuality';

/** Deux JPEG de 8 x 8 pixels, enregistrés par ImageMagick à une qualité connue. */
const Q60 =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//wAALCAAIAAgBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABcQAAMBAAAAAAAAAAAAAAAAAAAWYqH/2gAIAQEAAD8ATLsYf//Z';
const Q90 =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAAIAAgBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABcQAAMBAAAAAAAAAAAAAAAAAAAYZKL/2gAIAQEAAD8AU6qx5P/Z';

const bytes = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, 'base64'));

describe('qualité d’un JPEG', () => {
    it('retrouve la qualité d’enregistrement dans la table de quantification', () => {
        assert.equal(estimateJpegQuality(bytes(Q60)), 60);
        assert.equal(estimateJpegQuality(bytes(Q90)), 90);
    });

    it('ne dit rien d’un fichier qui n’est pas un JPEG, ni d’un JPEG tronqué avant ses tables', () => {
        assert.equal(estimateJpegQuality(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), null);
        assert.equal(estimateJpegQuality(new Uint8Array(0)), null);
        assert.equal(estimateJpegQuality(bytes(Q60).subarray(0, 12)), null);
    });
});
