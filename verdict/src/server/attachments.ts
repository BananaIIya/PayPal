// 提交给 PayPal 的证据附件。只发这笔索赔自己的证据：
// 复用检测可能引用其他买家的图片，那些不能发给这笔争议。
import sharp from 'sharp';
import type { PayPalDocument } from '@/paypal/client';
import type { EvidenceRow } from '@/analyzers';
import { claimEvidence, claimSignals } from './repo';
import { readFile } from './storage';

// PayPal 的限制：JPG、GIF、PNG、PDF；单个小于 10MB；每次合计不超过 50MB。
const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const PASS_THROUGH: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };

/** 被“反驳索赔”的信号引用过的证据。 */
export function selectAttachmentEvidence(claimId: string): EvidenceRow[] {
  const cited = new Set(
    claimSignals(claimId)
      .filter((s) => s.direction === 'contradicts_claim')
      .flatMap((s) => s.evidenceIds),
  );
  return claimEvidence(claimId)
    .filter((e) => cited.has(e.id))
    .slice(0, MAX_FILES);
}

async function toPayPalFile(row: EvidenceRow, index: number): Promise<PayPalDocument | null> {
  let data: Buffer;
  try {
    data = readFile(row.sha256);
  } catch {
    return null;
  }
  const extension = PASS_THROUGH[row.mime_type];
  if (extension && data.length < MAX_FILE_BYTES) {
    return { name: `evidence-${index + 1}.${extension}`, mime: row.mime_type, data };
  }
  try {
    const encoded = await sharp(data).rotate().resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    if (encoded.length >= MAX_FILE_BYTES) return null;
    return { name: `evidence-${index + 1}.jpg`, mime: 'image/jpeg', data: encoded };
  } catch {
    return null;
  }
}

export async function buildEvidenceDocuments(claimId: string): Promise<PayPalDocument[]> {
  const documents: PayPalDocument[] = [];
  let total = 0;
  const rows = selectAttachmentEvidence(claimId);
  for (const [index, row] of rows.entries()) {
    const file = await toPayPalFile(row, index);
    if (!file || total + file.data.length > MAX_TOTAL_BYTES) continue;
    total += file.data.length;
    documents.push(file);
  }
  return documents;
}
