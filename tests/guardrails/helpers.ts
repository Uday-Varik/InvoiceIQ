import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export const ROOT = join(import.meta.dirname, '..', '..');

export function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

export function readYaml<T = unknown>(rel: string): T {
  return parse(read(rel)) as T;
}

export function list(rel: string): string[] {
  return readdirSync(join(ROOT, rel)).sort();
}

/** Rows of the first markdown table that follows `heading` (header and separator dropped). */
export function tableAfter(markdown: string, heading: string): string[][] {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const lines = markdown.slice(start).split('\n');
  const rows: string[][] = [];
  let inTable = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith('|')) {
      inTable = true;
      rows.push(
        line
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim()),
      );
    } else if (inTable) {
      break;
    }
  }
  return rows.slice(2);
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export interface Operation {
  operationId: string;
  'x-phase': number;
}
export interface OpenApi {
  paths: Record<string, Partial<Record<HttpMethod, Operation>>>;
  components: { schemas: Record<string, { enum?: string[]; properties?: Record<string, { const?: string }> }> };
}

export function operations(spec: OpenApi): Array<{ key: string; op: Operation }> {
  const methods: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    methods.flatMap((m) => {
      const op = item[m];
      return op ? [{ key: `${m.toUpperCase()} ${path}`, op }] : [];
    }),
  );
}
