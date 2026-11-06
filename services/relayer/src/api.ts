import { HttpError, type Route } from '@xpool/service-common';
import { parseQuoteRequest, parseRelayRequest } from './schema.js';
import type { RelayService } from './service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** PRD 13.3 API. Bodies are validated strictly and never logged. */
export function relayerRoutes(svc: RelayService): Route[] {
  return [
    { method: 'GET', path: '/v1/info', cost: 1, handler: async () => ({ body: svc.info() }) },
    {
      method: 'POST',
      path: '/v1/quote',
      cost: 2,
      handler: async ({ body }) => {
        const parsed = parseQuoteRequest(body);
        if (!parsed.ok) throw new HttpError(400, 'invalid_request', 'invalid quote request', parsed.issues);
        return { body: await svc.quote(parsed.value) };
      },
    },
    {
      method: 'POST',
      path: '/v1/relay',
      cost: 5,
      handler: async ({ body }) => {
        const parsed = parseRelayRequest(body);
        if (!parsed.ok) throw new HttpError(400, 'invalid_request', 'invalid relay request', parsed.issues);
        return { status: 202, body: await svc.relay(parsed.value) };
      },
    },
    {
      method: 'GET',
      path: '/v1/status/:requestId',
      cost: 1,
      handler: async ({ params }) => {
        const id = params.requestId ?? '';
        if (!UUID_RE.test(id)) throw new HttpError(400, 'invalid_request_id');
        return { body: await svc.status(id) };
      },
    },
  ];
}
