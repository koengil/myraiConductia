// One well-formed line per event shape, with the exact JSON the sink must write
// (keys in FIELD_TABLE order, UUIDs lowercased) and the console method it uses.
import type { ServerLine } from '@/lib/log';

export const ID = '3F2C9A1E-0B7D-4C1A-9E55-2A6F0C1D7B10';
const id = ID.toLowerCase();

export type Method = 'log' | 'warn' | 'error';

export const LINES: Array<{ line: ServerLine; method: Method; json: string }> = [
  {
    line: { evt: 'auth_denied', reason: 'mfa_required', status: 403, gate: 'api', user: ID, company: ID },
    method: 'warn',
    json: `{"evt":"auth_denied","reason":"mfa_required","status":403,"gate":"api","user":"${id}","company":"${id}"}`,
  },
  {
    line: { evt: 'auth_unavailable', reason: 'profile_read', status: 503, gate: 'api_scoped' },
    method: 'error',
    json: '{"evt":"auth_unavailable","reason":"profile_read","status":503,"gate":"api_scoped"}',
  },
  {
    line: {
      evt: 'model_outcome', feature: 'milestone_extract', outcome: 'zdr_unavailable', failure: 'upstream_status',
      zdrReason: 'no_providers_available', status: 400, tenant: ID, ms: 412,
    },
    method: 'error',
    json: `{"evt":"model_outcome","feature":"milestone_extract","outcome":"zdr_unavailable","failure":"upstream_status","zdrReason":"no_providers_available","status":400,"tenant":"${id}","ms":412}`,
  },
  {
    line: { evt: 'model_outcome', feature: 'compliance_screen', outcome: 'ok', ms: 0 },
    method: 'log',
    json: '{"evt":"model_outcome","feature":"compliance_screen","outcome":"ok","ms":0}',
  },
  {
    line: { evt: 'request_error', routeType: 'route', method: 'POST', errorClass: 'db', status: 500, sqlstate: '22P02' },
    method: 'error',
    json: '{"evt":"request_error","routeType":"route","method":"POST","errorClass":"db","status":500,"sqlstate":"22P02"}',
  },
  {
    line: { evt: 'request_error', routeType: 'render', method: 'GET', errorClass: 'upstream', provider: 'box', status: 502 },
    method: 'error',
    json: '{"evt":"request_error","routeType":"render","method":"GET","errorClass":"upstream","provider":"box","status":502}',
  },
  {
    line: { evt: 'audit_write_failed', status: 0 },
    method: 'error',
    json: '{"evt":"audit_write_failed","status":0}',
  },
];
