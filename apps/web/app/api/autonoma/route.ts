// Autonoma Environment Factory endpoint
// This route handles discover, up, and down actions for automated test environments.
// Gated to non-production by default (the SDK rejects requests when NODE_ENV === "production").

import { createHmac } from "node:crypto";
import process from "node:process";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — moduleResolution incompatibility with package exports
import { createHandler } from "@autonoma-ai/server-web";
import { prisma } from "@calcom/prisma";

interface SQLExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: SQLExecutor) => Promise<T>): Promise<T>;
}

// Prisma's $queryRawUnsafe cannot deserialize PostgreSQL's `name` type returned
// by information_schema views and pg_type/pg_enum catalog views. This wrapper
// uses Prisma.$executeRawUnsafe for DDL and wraps SELECT queries in a CTE that
// casts all columns to text via json serialization, but a simpler approach is
// to just use the pg driver directly for information_schema queries.
//
// The simplest reliable workaround: wrap the problematic query in a subquery
// that casts everything to json and then back, or use string replacement.

function patchQuery(sql: string): string {
  // Only patch queries that hit information_schema or pg catalog
  if (!sql.includes("information_schema") && !sql.includes("pg_type") && !sql.includes("pg_enum")) {
    return sql;
  }

  // For information_schema queries, we need to cast `name` typed columns to text.
  // The approach: replace known column references with ::text casts.
  let patched = sql;

  // Wrap the entire query to cast all name-type columns
  // Tables query
  if (
    patched.includes("information_schema.tables") &&
    !patched.includes("information_schema.table_constraints")
  ) {
    patched = patched.replace(/\btable_name\b(?!\s*::)/g, "table_name::text");
    // Fix double-aliased or broken references in WHERE/ORDER clauses
    patched = patched.replace(/table_name::text::text/g, "table_name::text");
  }

  // Columns query
  if (
    patched.includes("information_schema.columns") &&
    !patched.includes("information_schema.table_constraints")
  ) {
    patched = patched.replace(/\btable_name\b(?!\s*::)/g, "table_name::text");
    patched = patched.replace(/\bcolumn_name\b(?!\s*::)/g, "column_name::text");
    patched = patched.replace(/\bdata_type\b(?!\s*::)/g, "data_type::text");
    patched = patched.replace(/\budt_name\b(?!\s*::)/g, "udt_name::text");
    patched = patched.replace(/\bis_nullable\b(?!\s*::)/g, "is_nullable::text");
    patched = patched.replace(/\bcolumn_default\b(?!\s*::)/g, "column_default::text");
    // Fix duplicates
    patched = patched.replace(/::text::text/g, "::text");
  }

  // Primary keys query: table_constraints + key_column_usage
  if (patched.includes("information_schema.table_constraints") && patched.includes("PRIMARY KEY")) {
    patched = patched.replace(/\btc\.table_name\b(?!\s*::)/g, "tc.table_name::text");
    patched = patched.replace(/\bkcu\.column_name\b(?!\s*::)/g, "kcu.column_name::text");
    patched = patched.replace(/::text::text/g, "::text");
  }

  // Foreign keys query: table_constraints + key_column_usage + constraint_column_usage
  if (patched.includes("information_schema.table_constraints") && patched.includes("FOREIGN KEY")) {
    patched = patched.replace(/\bkcu\.table_name\b(?!\s*::)/g, "kcu.table_name::text");
    patched = patched.replace(/\bkcu\.column_name\b(?!\s*::)/g, "kcu.column_name::text");
    patched = patched.replace(/\bccu\.table_name\b(?!\s*::)/g, "ccu.table_name::text");
    patched = patched.replace(/\bccu\.column_name\b(?!\s*::)/g, "ccu.column_name::text");
    patched = patched.replace(/\bc\.is_nullable\b(?!\s*::)/g, "c.is_nullable::text");
    patched = patched.replace(/\btc\.constraint_name\b(?!\s*::)/g, "tc.constraint_name::text");
    patched = patched.replace(/\bkcu\.constraint_name\b(?!\s*::)/g, "kcu.constraint_name::text");
    patched = patched.replace(/\bccu\.constraint_name\b(?!\s*::)/g, "ccu.constraint_name::text");
    patched = patched.replace(/\btc\.table_schema\b(?!\s*::)/g, "tc.table_schema::text");
    patched = patched.replace(/\bkcu\.table_schema\b(?!\s*::)/g, "kcu.table_schema::text");
    patched = patched.replace(/\bccu\.table_schema\b(?!\s*::)/g, "ccu.table_schema::text");
    patched = patched.replace(/\bc\.table_schema\b(?!\s*::)/g, "c.table_schema::text");
    patched = patched.replace(/\bc\.table_name\b(?!\s*::)/g, "c.table_name::text");
    patched = patched.replace(/\bc\.column_name\b(?!\s*::)/g, "c.column_name::text");
    patched = patched.replace(/::text::text/g, "::text");
  }

  // pg_type / pg_enum query for enums
  if (patched.includes("pg_type") && patched.includes("pg_enum")) {
    patched = patched.replace(/\bt\.typname\b(?!\s*::)/g, "t.typname::text");
    patched = patched.replace(/\be\.enumlabel\b(?!\s*::)/g, "e.enumlabel::text");
    patched = patched.replace(/::text::text/g, "::text");
  }

  return patched;
}

let pendingMembershipRoles: string[] = [];

function shouldSkipQuery(sql: string, params: unknown[]): boolean {
  if (!sql.startsWith("DELETE") && !sql.startsWith("UPDATE")) return false;
  if (params.length === 0) return false;
  const firstParam = params[0];
  if (typeof firstParam !== "string") return false;
  if (/^\d+$/.test(firstParam)) return false;
  if (sql.includes(" IN (")) return false;
  return true;
}

function patchInsertSql(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  // Membership.role: inject enum role stripped by the tree resolver
  if (sql.includes('"Membership"') && sql.startsWith("INSERT") && pendingMembershipRoles.length > 0) {
    const role = pendingMembershipRoles.shift() ?? "MEMBER";
    const paramIdx = params.length + 1;
    const m = sql.match(/^(INSERT INTO "Membership" \()(.*)(\) VALUES \()(.*)(\) RETURNING .*)$/);
    if (m) {
      const newSql = `${m[1]}${m[2]}, "role"${m[3]}${m[4]}, $${paramIdx}::"MembershipRole"${m[5]}`;
      return { sql: newSql, params: [...params, role] };
    }
  }

  // Users.uuid: auto-generate when not provided in the INSERT
  if (sql.includes('"users"') && sql.startsWith("INSERT") && !sql.includes('"uuid"')) {
    const m = sql.match(/^(INSERT INTO "users" \()(.*)(\) VALUES \()(.*)(\) RETURNING .*)$/i);
    if (m) {
      const newSql = `${m[1]}${m[2]}, "uuid"${m[3]}${m[4]}, gen_random_uuid()${m[5]}`;
      return { sql: newSql, params: [...params] };
    }
  }

  return { sql, params };
}

function calPrismaExecutor(): SQLExecutor {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const p = params ? Array.from(params) : [];
      if (shouldSkipQuery(sql, p)) return [] as T[];
      let patched = patchQuery(sql);
      const fixed = patchInsertSql(patched, p);
      patched = fixed.sql;
      const result = await prisma.$queryRawUnsafe<T[]>(patched, ...fixed.params);
      return result;
    },
    async transaction<T>(fn: (tx: SQLExecutor) => Promise<T>): Promise<T> {
      return prisma.$transaction(
        async (txClient) => {
          const txExecutor: SQLExecutor = {
            async query<U = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<U[]> {
              const p = params ? Array.from(params) : [];
              if (shouldSkipQuery(sql, p)) return [] as U[];
              let patched = patchQuery(sql);
              const fixed = patchInsertSql(patched, p);
              patched = fixed.sql;
              return txClient.$queryRawUnsafe<U[]>(patched, ...fixed.params);
            },
            transaction: <T2>(innerFn: (tx: SQLExecutor) => Promise<T2>): Promise<T2> => innerFn(txExecutor),
          };
          return fn(txExecutor);
        },
        { maxWait: 30000, timeout: 60000 }
      );
    },
  };
}

const PG_TYPE_MAP: Record<string, string> = {
  "time without time zone": "DateTime",
  "time with time zone": "DateTime",
  "timestamp without time zone": "DateTime",
  "timestamp with time zone": "DateTime",
  "character varying": "String",
  "double precision": "Float",
  bigint: "BigInt",
  smallint: "Int",
  numeric: "Decimal",
  bytea: "Bytes",
  jsonb: "Json",
  json: "Json",
  text: "String",
  integer: "Int",
  boolean: "Boolean",
  uuid: "String",
};

function normalizeDiscoverTypes(body: Record<string, unknown>): Record<string, unknown> {
  const schema = body.schema as Record<string, unknown> | undefined;
  if (!schema) return body;
  const models = schema.models as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(models)) return body;
  for (const model of models) {
    const fields = model.fields as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(fields)) continue;
    for (const field of fields) {
      const t = field.type as string;
      if (t && PG_TYPE_MAP[t]) {
        field.type = PG_TYPE_MAP[t];
      }
    }
  }
  return body;
}

// The SDK's tree resolver collides Membership.role (enum field) with
// Membership.role (relation to Role table via customRoleId). To work around
// this, we strip `role` from Membership records before handing the payload to
// the SDK, then backfill the enum value via a direct UPDATE after creation.

function extractMembershipRoles(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  roles: string[];
} {
  const create = body.create as Record<string, unknown[]> | undefined;
  if (!create) return { body, roles: [] };

  const roles: string[] = [];
  const memberships = create.Membership as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(memberships)) {
    for (const m of memberships) {
      if (typeof m.role === "string") {
        roles.push(m.role);
        delete m.role;
      }
    }
  }
  return { body, roles };
}

const sharedSecret = process.env.AUTONOMA_SHARED_SECRET ?? "";
const signingSecret = process.env.AUTONOMA_SIGNING_SECRET ?? "";

const innerHandler = createHandler({
  executor: calPrismaExecutor(),
  scopeField: "organizationId",
  sharedSecret,
  signingSecret,
  allowProduction: process.env.VERCEL_ENV === "preview",
  auth: async (user: Record<string, unknown> | null, _context: unknown) => {
    if (user?.id) {
      return { headers: { "x-cal-user-id": String(user.id) } };
    }
    return { headers: {} };
  },
});

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();

  let parsedBody: Record<string, unknown> | null = null;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    // pass through to handler
  }

  let finalRawBody = rawBody;
  if (parsedBody && parsedBody.action === "up" && parsedBody.create) {
    const result = extractMembershipRoles(parsedBody);
    pendingMembershipRoles = result.roles;
    finalRawBody = JSON.stringify(result.body);
  }

  const newHeaders = new Headers(request.headers);
  if (finalRawBody !== rawBody) {
    const sig = createHmac("sha256", sharedSecret).update(finalRawBody).digest("hex");
    newHeaders.set("x-signature", sig);
  }

  const newRequest = new Request(request.url, {
    method: request.method,
    headers: newHeaders,
    body: finalRawBody,
  });

  const response = await innerHandler(newRequest);
  pendingMembershipRoles = [];
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      const body = await response.json();
      if (body && typeof body === "object" && "schema" in body) {
        const normalized = normalizeDiscoverTypes(body as Record<string, unknown>);
        return new Response(JSON.stringify(normalized), {
          status: response.status,
          headers: response.headers,
        });
      }
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: response.headers,
      });
    } catch {
      return response;
    }
  }
  return response;
}
