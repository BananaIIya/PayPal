import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { renderReportPdf, ReportFontUnavailableError, type ReportAudience } from '@/server/report-pdf';

export const dynamic = 'force-dynamic';

/** 导出核验报告。?audience=paypal 预览随证据提交给 PayPal 的版本。 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const auth = authorize(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const audience: ReportAudience = req.nextUrl.searchParams.get('audience') === 'paypal' ? 'paypal' : 'merchant';
  try {
    const report = await renderReportPdf(id, audience);
    if (!report) return NextResponse.json({ error: '索赔不存在或还没有判定' }, { status: 404 });
    const name = audience === 'paypal' ? 'verdict-report-paypal.pdf' : report.fileName;
    return new NextResponse(new Uint8Array(report.data), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${name}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof ReportFontUnavailableError) return NextResponse.json({ error: e.message }, { status: 503 });
    throw e;
  }
}
