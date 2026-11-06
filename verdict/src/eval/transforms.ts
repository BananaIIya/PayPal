// 对抗样本里“内容不变而形式变化”的一类：压缩、裁剪、亮度调整、截图。
// 二次拍摄、视频转码、文字改写不在这里（需要真实设备或模型），README 里列为未覆盖。
import sharp from 'sharp';

export const TRANSFORM_NAMES = ['recompress', 'crop', 'brightness', 'screenshot'] as const;
export type TransformName = (typeof TRANSFORM_NAMES)[number];

export const TRANSFORM_TEXT: Record<TransformName, string> = {
  recompress: '重新压缩（JPEG 质量 55）',
  crop: '裁掉四周 6%',
  brightness: '调亮 15%',
  screenshot: '截图（缩到 75%，加状态栏和底栏，存成 PNG）',
};

const TRANSFORMS: Record<TransformName, (buf: Buffer) => Promise<Buffer>> = {
  recompress: (buf) => sharp(buf).jpeg({ quality: 55 }).toBuffer(),
  crop: async (buf) => {
    const { width = 0, height = 0 } = await sharp(buf).metadata();
    const dx = Math.round(width * 0.06);
    const dy = Math.round(height * 0.06);
    return sharp(buf)
      .extract({ left: dx, top: dy, width: width - 2 * dx, height: height - 2 * dy })
      .jpeg({ quality: 90 })
      .toBuffer();
  },
  brightness: (buf) => sharp(buf).modulate({ brightness: 1.15 }).jpeg({ quality: 90 }).toBuffer(),
  screenshot: async (buf) => {
    const { width = 0 } = await sharp(buf).metadata();
    const w = Math.round(width * 0.75);
    return sharp(buf)
      .resize({ width: w })
      .extend({ top: Math.round(w * 0.06), bottom: Math.round(w * 0.09), background: '#111111' })
      .png()
      .toBuffer();
  },
};

export function transform(name: TransformName): (buf: Buffer) => Promise<Buffer> {
  return TRANSFORMS[name];
}
