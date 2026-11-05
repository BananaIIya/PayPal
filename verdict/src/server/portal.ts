import { NextResponse } from 'next/server';
import { checkPortalToken, type TokenCheck } from './tokens';

type OkCheck = Extract<TokenCheck, { ok: true }>;

export function requireToken(token: string): OkCheck | NextResponse {
  const check = checkPortalToken(token);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });
  return check;
}
