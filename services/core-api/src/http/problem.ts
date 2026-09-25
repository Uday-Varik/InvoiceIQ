import type { FastifyReply } from 'fastify';

/** RFC 9457 problem details, thrown from handlers and rendered by the app's error handler. */
export class HttpProblem extends Error {
  override name = 'HttpProblem';
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
    readonly code?: string,
  ) {
    super(detail);
  }
}

export function problemBody(status: number, title: string, detail: string, code?: string) {
  return { type: 'about:blank', title, status, detail, ...(code ? { code } : {}) };
}

export function sendProblem(reply: FastifyReply, status: number, title: string, detail: string, code?: string) {
  return reply.code(status).type('application/problem+json').send(problemBody(status, title, detail, code));
}
