// 核验报告 PDF。两种读者：
// - merchant：商家下载存档，内容与报告网页一致。
// - paypal：随 provide-evidence / appeal 提交给 PayPal。去掉只给商家看的内容：
//   商家侧风险 M、内部提示、草稿、规则轨迹，以及 Behavior 分析器的发现
//  （开发文档“对买家的公平性”：内部风险标记不对外展示）。
//   图片只用这笔索赔自己的证据和本订单的商家留底，复用检测引用的其他买家图片不会出现在报告里。
//
// PDF 必须内嵌中文字体。字体不随仓库分发（体积太大），按 VERDICT_REPORT_FONT 和常见系统路径查找；
// 找不到时抛 ReportFontUnavailableError，调用方据此降级。
import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { ANALYZER_LABEL, CLAIM_TYPE_LABEL, LEVEL_LABEL, SHOT_LABEL, SOURCE_LABEL, STRENGTH_LABEL } from '@/core/catalog';
import { PORTAL_LINK_PLACEHOLDER } from '@/core/recommend';
import type { Finding, VerdictReport } from '@/core/types';
import { claimDetail, type ClaimDetail } from './repo';
import { readFile } from './storage';

export type ReportAudience = 'merchant' | 'paypal';

export class ReportFontUnavailableError extends Error {
  constructor() {
    super('找不到可以内嵌的中文字体，无法生成 PDF。请安装 Noto Sans CJK 或文泉驿正黑，或用 VERDICT_REPORT_FONT 指定字体文件。');
    this.name = 'ReportFontUnavailableError';
  }
}

interface FontCandidate {
  path: string;
  /** TTC 字体集里要用的字体的 PostScript 名称；TTF/OTF 不需要。 */
  family?: string;
}

const FONT_CANDIDATES: FontCandidate[] = [
  // Linux
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'NotoSansCJKsc-Regular' },
  { path: '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc', family: 'NotoSansCJKsc-Regular' },
  { path: '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc', family: 'NotoSansCJKsc-Regular' },
  { path: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', family: 'WenQuanYiZenHei' },
  { path: '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', family: 'WenQuanYiMicroHei' },
  { path: '/usr/share/fonts/wenquanyi/wqy-zenhei/wqy-zenhei.ttc', family: 'WenQuanYiZenHei' },
  // macOS
  { path: '/System/Library/Fonts/STHeiti Light.ttc', family: 'STHeitiSC-Light' },
  { path: '/System/Library/Fonts/STHeiti Medium.ttc', family: 'STHeitiSC-Medium' },
  { path: '/System/Library/Fonts/Supplemental/Songti.ttc', family: 'STSongti-SC-Regular' },
  { path: '/Library/Fonts/Arial Unicode.ttf' },
  { path: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf' },
  // Windows
  { path: 'C:\\Windows\\Fonts\\msyh.ttc', family: 'MicrosoftYaHei' },
  { path: 'C:\\Windows\\Fonts\\simhei.ttf' },
];

const g = globalThis as unknown as { __verdictReportFont?: FontCandidate | null };

function usable(candidate: FontCandidate): boolean {
  if (!fs.existsSync(candidate.path)) return false;
  try {
    const probe = new PDFDocument({ autoFirstPage: false });
    probe.registerFont('probe', candidate.path, candidate.family);
    probe.font('probe');
    return true;
  } catch {
    return false;
  }
}

/** 第一个能加载的中文字体。结果按进程缓存；没有时返回 null。 */
export function findReportFont(): FontCandidate | null {
  const configured = process.env.VERDICT_REPORT_FONT?.trim();
  if (configured) {
    // 显式配置时不缓存、不回退：配错了要让人看到，而不是悄悄换成别的字体。
    const candidate = { path: configured, family: process.env.VERDICT_REPORT_FONT_FAMILY?.trim() || undefined };
    return usable(candidate) ? candidate : null;
  }
  if (g.__verdictReportFont === undefined) g.__verdictReportFont = FONT_CANDIDATES.find(usable) ?? null;
  return g.__verdictReportFont;
}

const STATUS = { holds: '成立', refuted: '不成立', insufficient: '证据不足' } as const;

const PAGE_MARGIN = 50;
const COLOR = { text: '#1f2328', muted: '#656d76', line: '#d0d7de', high: '#b42318', low: '#1a7f37', medium: '#9a6700' };

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function fmtMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

/** 提交给 PayPal 的版本去掉 Behavior 发现；两种版本都只保留能落到可公开图片上的证据 ID。 */
export function visibleFindings(report: VerdictReport, audience: ReportAudience): Finding[] {
  return audience === 'paypal' ? report.findings.filter((f) => f.analyzer !== 'behavior') : report.findings;
}

function headline(report: VerdictReport, findings: Finding[], audience: ReportAudience): string {
  if (audience === 'merchant') return report.headline;
  const top = findings.find((f) => f.direction === 'contradicts_claim');
  if (report.level === 'high') return top?.title ?? '存在明确的反驳证据';
  if (report.level === 'medium') return top ? `${top.title}，需要进一步核对` : '现有证据无法下结论，需要进一步核对';
  return report.headline;
}

async function thumbnail(sha256: string): Promise<Buffer | null> {
  try {
    return await sharp(readFile(sha256)).rotate().resize({ width: 360, height: 270, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
  } catch {
    return null;
  }
}

export interface RenderedReport {
  data: Buffer;
  verdictId: string;
  fileName: string;
}

/** 生成最新判定的报告。索赔不存在或还没有判定时返回 null。 */
export async function renderReportPdf(claimId: string, audience: ReportAudience): Promise<RenderedReport | null> {
  const detail = claimDetail(claimId);
  if (!detail?.verdict) return null;
  const font = findReportFont();
  if (!font) throw new ReportFontUnavailableError();

  // 可以出现在报告里的图片：本索赔的证据和本订单的留底。
  const images = new Map<string, { sha256: string; label: string }>();
  for (const e of [...detail.evidence, ...detail.references]) {
    images.set(e.id, { sha256: e.sha256, label: `${e.layer} 层 · ${SHOT_LABEL[e.shotLabel ?? ''] ?? SOURCE_LABEL[e.source]}` });
  }
  const thumbs = new Map<string, Buffer>();
  const findings = visibleFindings(detail.verdict.report, audience);
  for (const id of new Set(findings.flatMap((f) => f.evidenceIds))) {
    const image = images.get(id);
    if (!image) continue;
    const buf = await thumbnail(image.sha256);
    if (buf) thumbs.set(id, buf);
  }

  const data = await draw(detail, audience, font, findings, thumbs, images);
  return { data, verdictId: detail.verdict.id, fileName: 'verdict-report.pdf' };
}

function draw(
  detail: ClaimDetail,
  audience: ReportAudience,
  font: FontCandidate,
  findings: Finding[],
  thumbs: Map<string, Buffer>,
  images: Map<string, { sha256: string; label: string }>,
): Promise<Buffer> {
  const verdict = detail.verdict!;
  const r = verdict.report;
  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE_MARGIN,
    bufferPages: true,
    info: { Title: `Verdict 核验报告 ${detail.order.orderNo}`, Author: 'Verdict', Subject: `判定 ${verdict.id}` },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.registerFont('cjk', font.path, font.family);
  doc.font('cjk').fillColor(COLOR.text);
  const width = doc.page.width - PAGE_MARGIN * 2;

  const ensureSpace = (height: number) => {
    if (doc.y + height > doc.page.height - PAGE_MARGIN) doc.addPage();
  };
  const heading = (text: string) => {
    ensureSpace(60);
    doc.moveDown(0.8).fontSize(13).fillColor(COLOR.text).text(text);
    const y = doc.y + 2;
    doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + width, y).lineWidth(0.5).strokeColor(COLOR.line).stroke();
    doc.moveDown(0.5);
  };
  const para = (text: string, opts: { size?: number; color?: string } = {}) => {
    doc.fontSize(opts.size ?? 10).fillColor(opts.color ?? COLOR.text).text(text, { width, lineGap: 2 });
  };
  const small = (text: string) => para(text, { size: 8.5, color: COLOR.muted });

  // ---------- 标题 ----------
  doc.fontSize(18).text('核验报告');
  doc.moveDown(0.3);
  small(
    [
      `订单 ${detail.order.orderNo}`,
      detail.order.items[0]?.title,
      fmtMoney(detail.order.amount, detail.order.currency),
      CLAIM_TYPE_LABEL[detail.claim.type],
      detail.claim.disputeId ? `PayPal 争议 ${detail.claim.disputeId}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  small(`判定时间 ${fmtTime(verdict.createdAt)} · 判定 ID ${verdict.id} · 规则版本 ${r.rulesVersion}`);
  if (audience === 'paypal') {
    small('本报告由商家使用 Verdict 生成，随争议回应提交。结论由确定性规则根据下列信号计算，最终决定由商家作出。');
  }

  // ---------- 结论 ----------
  heading('结论');
  const levelColor = r.level === 'high' ? COLOR.high : r.level === 'low' ? COLOR.low : COLOR.medium;
  para(`${LEVEL_LABEL[r.level]}：${headline(r, findings, audience)}${r.incomplete ? '（核验不完整）' : ''}`, { size: 11.5, color: levelColor });
  doc.moveDown(0.3);
  para(
    audience === 'merchant'
      ? `买家侧风险 R = ${r.score.toFixed(2)}，数据置信度 Q = ${r.dataConfidence.toFixed(2)}，商家侧风险 M = ${r.merchantRisk.toFixed(2)}`
      : `风险分 R = ${r.score.toFixed(2)}，数据置信度 Q = ${r.dataConfidence.toFixed(2)}`,
  );
  if (audience === 'merchant') {
    para(`建议动作：${r.primaryAction.label}。${r.primaryAction.reason}`);
    para(`需要商家决定：${r.decisionNeeded}。`);
    for (const n of r.notices) para(`· ${n}`);
  }

  // ---------- 命题核验 ----------
  heading('命题核验');
  for (const p of r.propositions) {
    ensureSpace(30);
    para(`${p.label}${p.key ? '（关键）' : ''}`);
    small(`状态：${STATUS[p.status]} · 证据层级：${p.layers.join('、') || '—'}${p.note ? ` · ${p.note}` : ''}`);
    doc.moveDown(0.2);
  }

  // ---------- 发现 ----------
  heading('发现');
  if (findings.length === 0) small('没有信号。');
  for (const f of findings) {
    ensureSpace(70);
    para(f.title, { size: 10.5 });
    small(
      [
        ANALYZER_LABEL[f.analyzer].name,
        `强度${STRENGTH_LABEL[f.strength]}`,
        `置信度 ${f.confidence.toFixed(2)}`,
        f.direction === 'contradicts_claim' ? '与索赔矛盾' : f.direction === 'supports_claim' ? '支持索赔' : '中性',
        f.provider === 'recorded-fixture' ? '录制回放' : f.provider,
      ]
        .filter(Boolean)
        .join(' · '),
    );
    para(f.explanation);
    const shown = f.evidenceIds.filter((id) => thumbs.has(id)).slice(0, 4);
    if (shown.length) {
      const boxW = 110;
      const boxH = 82;
      ensureSpace(boxH + 24);
      const top = doc.y + 4;
      shown.forEach((id, i) => {
        const x = PAGE_MARGIN + i * (boxW + 10);
        doc.image(thumbs.get(id)!, x, top, { fit: [boxW, boxH], align: 'center', valign: 'center' });
        doc.fontSize(7.5).fillColor(COLOR.muted).text(images.get(id)!.label, x, top + boxH + 2, { width: boxW, lineBreak: false, ellipsis: true });
      });
      doc.x = PAGE_MARGIN;
      doc.y = top + boxH + 14;
    }
    if (f.normalExplanations.length) small(`需排除的正常解释：${f.normalExplanations.join('；')}`);
    doc.moveDown(0.5);
  }

  // ---------- 证据清单 ----------
  heading('证据清单');
  if (detail.evidence.length === 0) small('没有图片证据。');
  for (const e of detail.evidence) {
    ensureSpace(24);
    para(`${e.layer} 层 · ${SOURCE_LABEL[e.source]} · ${SHOT_LABEL[e.shotLabel ?? ''] ?? '未标注'} · ${fmtTime(e.createdAt)}`, { size: 9 });
    small(`SHA-256 ${e.sha256}${e.challenge ? ` · 挑战码 ${e.challenge.code}` : ''}`);
  }

  // ---------- 时间线 ----------
  heading('时间线');
  for (const t of detail.timeline) {
    ensureSpace(16);
    para(`${fmtTime(t.at)}  ${t.title}${t.detail ? ` · ${SHOT_LABEL[t.detail] ?? t.detail}` : ''}`, { size: 9 });
  }

  // ---------- 未执行的检查 ----------
  heading('未执行的检查');
  if (r.notRun.length === 0) small('适用的分析器全部完成。');
  for (const n of r.notRun) para(`${ANALYZER_LABEL[n.analyzer].name}（${ANALYZER_LABEL[n.analyzer].what}）：${n.reason}`, { size: 9 });

  if (audience === 'merchant') {
    const action = r.primaryAction;
    if (action.message || action.notes) {
      heading('草稿');
      if (action.message) para(`给买家的消息：${action.message.replaceAll(PORTAL_LINK_PLACEHOLDER, '（发送时生成的一次性索赔页链接）')}`);
      if (action.notes) para(`说明：${action.notes}`);
    }
    heading('审计记录');
    small(`规则版本 ${r.rulesVersion}`);
    for (const t of r.ruleTrace) small(`· ${t}`);
  }

  // ---------- 页脚 ----------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .fontSize(7.5)
      .fillColor(COLOR.muted)
      .text(`Verdict · 判定 ${verdict.id} · 第 ${i + 1} / ${range.count} 页`, PAGE_MARGIN, doc.page.height - 30, { width, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return done;
}
