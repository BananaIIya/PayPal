// 不依赖原生库的来源凭证扫描：定位 C2PA 清单容器和 GB 45438 隐式标识。
// 能回答“文件里有没有 AI 来源声明”，不能回答“签名是否有效”。开发文档指定的
// @contentauth/c2pa-node 验签留到后续接入，所以这里不会输出 CAMERA_PROVENANCE_VALID。

export interface ProvenanceScan {
  c2paManifest: boolean;
  aiSourceType: boolean;
  aigcLabel: boolean;
  generator: string | null;
  containers: string[];
}

const AI_SOURCE_TYPES = ['trainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia', 'algorithmicMedia'];
const GENERATOR_RE = /(ChatGPT|OpenAI|DALL[·.\- ]?E|Sora|Gemini|Imagen|Adobe[ _]Firefly|Firefly|Midjourney|Stable[ _]Diffusion|Flux|Doubao|Kling)/i;

function pngChunks(buf: Buffer): { type: string; data: Buffer }[] {
  const chunks: { type: string; data: Buffer }[] = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (p + 8 + len > buf.length) break;
    chunks.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

function jpegSegments(buf: Buffer): { marker: number; data: Buffer }[] {
  const segs: { marker: number; data: Buffer }[] = [];
  let p = 2;
  while (p + 4 <= buf.length && buf[p] === 0xff) {
    const marker = buf[p + 1];
    if (marker === 0xda || marker === 0xd9) break; // 进入图像数据，元数据段到此结束
    const len = buf.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > buf.length) break;
    segs.push({ marker, data: buf.subarray(p + 4, p + 2 + len) });
    p += 2 + len;
  }
  return segs;
}

function webpChunks(buf: Buffer): { type: string; data: Buffer }[] {
  const chunks: { type: string; data: Buffer }[] = [];
  let p = 12;
  while (p + 8 <= buf.length) {
    const type = buf.toString('latin1', p, p + 4);
    const len = buf.readUInt32LE(p + 4);
    if (p + 8 + len > buf.length) break;
    chunks.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 8 + len + (len % 2);
  }
  return chunks;
}

export function scanProvenance(buf: Buffer, mime: string): ProvenanceScan {
  const manifests: Buffer[] = [];
  const metadata: Buffer[] = [];
  const containers: string[] = [];

  if (mime === 'image/jpeg') {
    for (const seg of jpegSegments(buf)) {
      if (seg.marker === 0xeb && (seg.data.includes('jumb') || seg.data.includes('c2pa'))) {
        manifests.push(seg.data);
        if (!containers.includes('JPEG APP11')) containers.push('JPEG APP11');
      } else if (seg.marker >= 0xe0 && seg.marker <= 0xef) {
        metadata.push(seg.data);
      }
    }
  } else if (mime === 'image/png') {
    for (const c of pngChunks(buf)) {
      if (c.type === 'caBX') {
        manifests.push(c.data);
        containers.push('PNG caBX');
      } else if (c.type === 'tEXt' || c.type === 'iTXt' || c.type === 'zTXt') {
        metadata.push(c.data);
      }
    }
  } else if (mime === 'image/webp') {
    for (const c of webpChunks(buf)) {
      if (c.type === 'C2PA') {
        manifests.push(c.data);
        containers.push('WebP C2PA');
      } else if (c.type === 'XMP ' || c.type === 'EXIF') {
        metadata.push(c.data);
      }
    }
  }

  const manifestText = Buffer.concat(manifests).toString('latin1');
  const metaText = Buffer.concat(metadata).toString('latin1');
  const aiSourceType = AI_SOURCE_TYPES.some((t) => manifestText.includes(t) || metaText.includes(t));
  // GB 45438-2025 附录 E：XMP 中的 TC260:AIGC，或 PNG 文本块中以 AIGC 为键的 JSON。
  const aigcLabel = /TC260:AIGC|tc260\.org\.cn\/ns\/AIGC|(^|\0)AIGC\0|"AIGC"\s*:/.test(metaText);
  const generator = manifestText.match(GENERATOR_RE)?.[1] ?? (aigcLabel ? metaText.match(GENERATOR_RE)?.[1] : null) ?? null;

  return { c2paManifest: manifests.length > 0, aiSourceType, aigcLabel, generator, containers };
}
