import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { requestOrigin } from '@/server/origin';
import { cancelTestOrder } from '@/server/sandbox-shop';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  await ready();
  cancelTestOrder(req.nextUrl.searchParams.get('token') ?? '');
  return NextResponse.redirect(`${requestOrigin(req)}/orders`, 303);
}
