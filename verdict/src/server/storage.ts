// 证据文件存储。文件名只用 SHA-256，绝不使用用户提供的文件名。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { dataDir } from './db';

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
/** 索赔页录的短视频最长 15 秒，相册里的视频可能更长，留足余量。 */
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
/** 一次上传请求的上限，要和 next.config.ts 的 proxyClientMaxBodySize 一致：超过的部分会被 proxy 截断。 */
export const MAX_REQUEST_BYTES = 48 * 1024 * 1024;

/** 先看 Content-Length，超限时直接给出清楚的错误，而不是解析一个被截断的表单。 */
export function requestTooLarge(req: Request): boolean {
  return Number(req.headers.get('content-length') ?? 0) > MAX_REQUEST_BYTES;
}

export function sha256(buf: Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fileDir(): string {
  const dir = path.join(dataDir(), 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveFile(buf: Buffer): string {
  const hash = sha256(buf);
  const target = path.join(fileDir(), hash);
  if (!fs.existsSync(target)) fs.writeFileSync(target, buf);
  return hash;
}

export function readFile(hash: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('invalid hash');
  return fs.readFileSync(path.join(fileDir(), hash));
}

/** 按文件头判断类型，不信任客户端声明的 Content-Type。 */
export function sniffImageType(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

export type VideoMime = 'video/mp4' | 'video/webm' | 'video/quicktime';

/** 视频同样按文件头判断：WebM（MediaRecorder 在 Chrome、安卓上的输出）和 MP4/MOV（iPhone）。 */
export function sniffVideoType(buf: Buffer): VideoMime | null {
  if (buf.length > 40 && buf.readUInt32BE(0) === 0x1a45dfa3) {
    // EBML 头里的 DocType：只接受 webm，Matroska（.mkv）浏览器播不了。
    return buf.subarray(0, 64).includes('webm') ? 'video/webm' : null;
  }
  if (buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    // HEIC、AVIF 也是 ftyp 容器，但它们是图片。
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1', 'avif', 'avis'].includes(brand)) return null;
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  return null;
}

/**
 * 256 位 dHash。比常见的 64 位更不容易误报：EVIDENCE_REUSED_ACROSS_CLAIMS 是硬规则信号，
 * 误报直接导致高风险，所以宁可漏也不要错。
 */
export async function perceptualHash(buf: Buffer): Promise<string> {
  const size = 16;
  const { data } = await sharp(buf)
    .rotate()
    .greyscale()
    .resize(size + 1, size, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      bits += data[y * (size + 1) + x] < data[y * (size + 1) + x + 1] ? '1' : '0';
    }
  }
  return bits;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/**
 * 256 位中差异不超过这个值，认为是同一张图。
 * 命中后是硬规则，误报等于冤枉诚实买家，所以取偏严的一侧：宁可漏掉被重度编辑过的复用图。
 * 校准依据（都是程序生成的演示图）：压缩并裁剪 2%、调亮的同图距离 35 到 45，同模板的不同面单最小 55。
 * 真实照片（尤其同店铺同背景的商品图）的分布可能不同，上线前需要用真实样本重新校准。
 */
export const REUSE_DISTANCE = 40;

const MIN_HASH_BITS = 64;

/** 纯色、黑帧、过曝这类低纹理图的差分哈希几乎全 0 或全 1，距离再小也不代表是同一张图。 */
export function isInformativeHash(hash: string): boolean {
  let ones = 0;
  for (const bit of hash) if (bit === '1') ones++;
  return ones >= MIN_HASH_BITS && hash.length - ones >= MIN_HASH_BITS;
}
