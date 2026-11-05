import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { db, newId, nowIso } from '@/server/db';
import { requireToken } from '@/server/portal';

export const dynamic = 'force-dynamic';

const ACTIONS = ['把商品翻到背面', '用手指一下问题部位', '把商品转动 90 度', '把纸条放到商品左侧', '把纸条放到商品右侧'];
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉容易混淆的 0 O 1 I L

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  await ready();
  const { token } = await params;
  const check = requireToken(token);
  if (check instanceof NextResponse) return check;
  const body = await req.json().catch(() => ({}));
  const id = newId();
  const code = Array.from({ length: 6 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  const action = ACTIONS[crypto.randomInt(ACTIONS.length)];
  db()
    .prepare('INSERT INTO challenges (id, claim_id, shot_label, code, action, issued_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, check.payload.claimId, String(body.shot ?? ''), code, action, nowIso());
  return NextResponse.json({ challengeId: id, code, action });
}
