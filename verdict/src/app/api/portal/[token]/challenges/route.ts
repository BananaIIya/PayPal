import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { db, newId, nowIso } from '@/server/db';
import { requireToken } from '@/server/portal';
import { limitPortal } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

const ACTIONS = ['Turn the item over', 'Point at the problem area', 'Rotate the item 90 degrees', 'Put the note to the left of the item', 'Put the note to the right of the item'];
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉容易混淆的 0 O 1 I L

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  await ready();
  const { token } = await params;
  const limited = limitPortal(req, token, 'challenge');
  if (limited) return limited;
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
