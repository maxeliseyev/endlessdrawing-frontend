import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeMessagePack, encodeMessagePack } from '../../src/transport/msgpack';

for (const version of ['ws-v2', 'ws-v3', 'ws-v4']) {
  const directory = new URL(`../fixtures/${version}/`, import.meta.url);
  const corpus = JSON.parse(readFileSync(new URL('corpus.json', directory), 'utf8')) as { name: string; value: Record<string, unknown> }[];
  const hashes = JSON.parse(readFileSync(new URL('sha256.json', directory), 'utf8')) as Record<string, string>;

  describe(`shared Rust / TypeScript wire corpus (${version})`, () => {
    it('pins every copied fixture and the semantic corpus by SHA-256', () => {
      for (const [name, hash] of Object.entries(hashes)) {
        expect(createHash('sha256').update(readFileSync(new URL(name, directory))).digest('hex'), name).toBe(hash);
      }
    });
    for (const { name, value } of corpus) {
      it(`decodes both encoder outputs: ${name}`, () => {
        for (const encoder of ['rust', 'ts']) {
          expect(decodeMessagePack(readFileSync(new URL(`${name}.${encoder}.msgpack`, directory)))).toEqual(value);
        }
        expect(decodeMessagePack(encodeMessagePack(value))).toEqual(value);
      });
    }
  });

}
