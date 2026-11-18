// Regenerate only the TypeScript encoder fixtures. Rust fixtures come from its codec test.
import { encode } from '@msgpack/msgpack';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const directory = resolve(process.argv[2] ?? 'tests/fixtures/ws-v2');
const corpus = JSON.parse(readFileSync(join(directory, 'corpus.json'), 'utf8'));
for (const { name, value } of corpus) writeFileSync(join(directory, `${name}.ts.msgpack`), encode(value, { forceFloat32: false }));
