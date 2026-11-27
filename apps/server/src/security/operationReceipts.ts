import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Transaction } from './commandAccess.js';

const requestIdSchema = z.uuid();
const retentionDays = 90;

export type ReceiptScope = {
  actorId: string;
  campaignId: string | null;
  operationType: string;
  requestId: string;
};

export type ReceiptResult =
  | { kind: 'new'; scope: ReceiptScope; payloadDigest: string }
  | { kind: 'replay'; resultIds: string[] }
  | { kind: 'conflict' }
  | { kind: 'invalid' };

type ReceiptRow = { payload_digest: string; result_ids: string[]; expired: boolean };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function operationRequestId(header: string | string[] | undefined): string | null | 'invalid' {
  if (header === undefined) return null;
  if (Array.isArray(header)) return 'invalid';
  const parsed = requestIdSchema.safeParse(header);
  return parsed.success ? parsed.data.toLowerCase() : 'invalid';
}

export function childOperationRequestId(parent: string, ordinal: number): string {
  const bytes = createHash('sha256').update(`${parent}:${ordinal}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Serializes only the same actor/scope/operation/request identity within PostgreSQL. */
export async function lockOperationReceipt(
  tx: Transaction,
  scope: ReceiptScope,
  payload: unknown,
): Promise<ReceiptResult> {
  const payloadDigest = createHash('sha256').update(canonical(payload)).digest('hex');
  const identity = `${scope.actorId}:${scope.campaignId ?? 'user'}:${scope.operationType}:${scope.requestId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity}, 0))`);
  const found = await tx.execute(sql`
    select payload_digest, result_ids, expires_at <= clock_timestamp() as expired
    from rest_operation_receipts
    where actor_id = ${scope.actorId}::uuid
      and campaign_id is not distinct from ${scope.campaignId}::uuid
      and operation_type = ${scope.operationType}
      and request_id = ${scope.requestId}::uuid
    for update
  `);
  const rows = (found as unknown as { rows: ReceiptRow[] }).rows;
  const existing = rows[0];
  if (existing) {
    if (existing.expired) {
      await tx.execute(sql`delete from rest_operation_receipts where actor_id = ${scope.actorId}::uuid and campaign_id is not distinct from ${scope.campaignId}::uuid and operation_type = ${scope.operationType} and request_id = ${scope.requestId}::uuid`);
    } else {
      return existing.payload_digest === payloadDigest
        ? { kind: 'replay', resultIds: existing.result_ids }
        : { kind: 'conflict' };
    }
  }
  return { kind: 'new', scope, payloadDigest };
}

export async function saveOperationReceipt(tx: Transaction, result: Extract<ReceiptResult, { kind: 'new' }>, resultIds: string[]) {
  await tx.execute(sql`
    insert into rest_operation_receipts (actor_id, campaign_id, operation_type, request_id, payload_digest, result_ids, expires_at)
    values (${result.scope.actorId}::uuid, ${result.scope.campaignId}::uuid, ${result.scope.operationType}, ${result.scope.requestId}::uuid, ${result.payloadDigest}, ${JSON.stringify(resultIds)}::jsonb, now() + (${retentionDays} * interval '1 day'))
  `);
}
