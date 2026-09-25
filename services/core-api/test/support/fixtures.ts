import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCS = join(import.meta.dirname, '..', '..', '..', 'ai-service', 'tests', 'fixtures', 'documents');

/** The same generated PDFs the ai-service tests read, so both sides test one document. */
export const SAMPLE_PDF = readFileSync(join(DOCS, 'sample-invoice.pdf'));
export const MESSY_PDF = readFileSync(join(DOCS, 'messy-invoice.pdf'));

export function uniquePdf(tag: string): Buffer {
  // A trailing comment changes the bytes (and so the sha256) but not the document.
  return Buffer.concat([SAMPLE_PDF, Buffer.from(`\n% ${tag}\n`)]);
}
