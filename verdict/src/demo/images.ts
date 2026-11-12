// 演示证据图：程序生成的占位插画，右下角有明确标记，不是真实照片。
// 每张图的背景由种子决定，保证不同图片的感知哈希相差足够大。
import sharp from 'sharp';

export type Scene =
  | { kind: 'mug'; seed: number; crack?: boolean; color?: string; code?: string; recapture?: boolean; count?: number }
  | { kind: 'mug_close'; seed: number; code?: string; recapture?: boolean }
  | { kind: 'earbuds'; seed: number; code?: string; scratched?: boolean }
  | { kind: 'crab'; seed: number; count?: number; spoiled?: boolean; code?: string }
  | { kind: 'jacket'; seed: number; color: string; code?: string }
  | { kind: 'box'; seed: number; dented?: boolean; open?: boolean; code?: string }
  | { kind: 'label'; seed: number; tracking: string; zip: string; code?: string }
  | { kind: 'serial'; seed: number; serial: string; code?: string }
  | { kind: 'contents'; seed: number; items: number; code?: string }
  | { kind: 'chat'; seed: number; orderNo: string; lines: { me: boolean; text: string }[] };

const W = 960;
const H = 720;

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function esc(t: string) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function background(seed: number): string {
  const r = rng(seed + 11);
  const hue = Math.floor(r() * 50) + 18;
  const base = `hsl(${hue}, 24%, ${60 + r() * 22}%)`;
  let shapes = `<rect width="${W}" height="${H}" fill="${base}"/>`;
  for (let i = 0; i < 46; i++) {
    const x = r() * W;
    const y = r() * H;
    const w = 50 + r() * 300;
    const h = 40 + r() * 240;
    const light = r() > 0.5;
    const op = 0.1 + r() * 0.34;
    const fill = light ? `rgba(255,250,240,${op})` : `rgba(30,22,14,${op})`;
    shapes += r() > 0.5
      ? `<ellipse cx="${x}" cy="${y}" rx="${w / 2}" ry="${h / 2}" fill="${fill}"/>`
      : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" transform="rotate(${r() * 50 - 25} ${x} ${y})"/>`;
  }
  return shapes;
}

function challengeNote(code?: string): string {
  if (!code) return '';
  return `<g transform="translate(700 560) rotate(-5)">
    <rect width="212" height="96" rx="4" fill="#fffef6" stroke="#c9c2ac"/>
    <text x="106" y="64" font-family="Menlo, monospace" font-size="42" font-weight="700" fill="#1d1d1f" text-anchor="middle">${esc(code)}</text>
  </g>`;
}

function mugShape(x: number, y: number, color: string, crack: boolean, scale = 1): string {
  const crackPath = crack
    ? `<polyline points="70,38 96,84 78,122 116,172 98,218" fill="none" stroke="#2b1d12" stroke-width="5" stroke-linejoin="round"/>
       <polyline points="96,84 128,102" fill="none" stroke="#2b1d12" stroke-width="3"/>`
    : '';
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <ellipse cx="110" cy="262" rx="130" ry="20" fill="rgba(0,0,0,.25)"/>
    <path d="M214 62 q88 6 78 82 q-8 68 -82 62" fill="none" stroke="${color}" stroke-width="28"/>
    <rect x="0" y="0" width="220" height="262" rx="22" fill="${color}"/>
    <ellipse cx="110" cy="6" rx="110" ry="20" fill="#f4f4ec"/>
    <ellipse cx="110" cy="8" rx="94" ry="14" fill="#5c5247"/>
    <rect x="18" y="26" width="30" height="210" rx="15" fill="rgba(255,255,255,.28)"/>
    ${crackPath}
  </g>`;
}

function recaptureOverlay(): string {
  let lines = '';
  for (let i = 0; i < H; i += 5) {
    lines += `<line x1="0" y1="${i}" x2="${W}" y2="${i + 3}" stroke="rgba(30,30,60,.2)" stroke-width="1"/>`;
  }
  return `${lines}<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#111" stroke-width="44"/>
    <ellipse cx="240" cy="150" rx="210" ry="74" fill="rgba(255,255,255,.2)" transform="rotate(-18 240 150)"/>`;
}

function drawScene(s: Scene): string {
  const bg = background(s.seed);
  switch (s.kind) {
    case 'mug': {
      const n = s.count ?? 1;
      let mugs = '';
      for (let i = 0; i < n; i++) {
        const x = n === 1 ? 340 : 110 + i * (640 / n);
        mugs += mugShape(x, 200, s.color ?? '#9dbcae', !!s.crack && i === 0, n === 1 ? 1 : 0.8);
      }
      return `${bg}${mugs}${challengeNote(s.code)}${s.recapture ? recaptureOverlay() : ''}`;
    }
    case 'mug_close':
      return `${bg}<g transform="translate(120 40) scale(2.3)">
        <rect x="0" y="0" width="220" height="262" rx="22" fill="#9dbcae"/>
        <polyline points="70,38 96,84 78,122 116,172 98,218" fill="none" stroke="#2b1d12" stroke-width="5" stroke-linejoin="round"/>
        <polyline points="96,84 128,102" fill="none" stroke="#2b1d12" stroke-width="3"/>
      </g>${challengeNote(s.code)}${s.recapture ? recaptureOverlay() : ''}`;
    case 'earbuds':
      return `${bg}<g transform="translate(290 170)">
        <rect width="380" height="300" rx="90" fill="#f5f5f2" stroke="#c4c4bd" stroke-width="3"/>
        <line x1="8" y1="118" x2="372" y2="118" stroke="#b7b7b0" stroke-width="4"/>
        <circle cx="190" cy="190" r="9" fill="#55c776"/>
        ${s.scratched ? '<polyline points="60,170 130,235 90,262 170,280" fill="none" stroke="#6d6d68" stroke-width="5"/>' : ''}
      </g>${challengeNote(s.code)}`;
    case 'crab': {
      const n = s.count ?? 5;
      let crabs = '';
      const r = rng(s.seed + 3);
      for (let i = 0; i < n; i++) {
        const x = 190 + (i % 3) * 210 + r() * 30;
        const y = 220 + Math.floor(i / 3) * 170 + r() * 20;
        crabs += `<g transform="translate(${x} ${y})">
          <ellipse rx="78" ry="54" fill="${s.spoiled ? '#7c5a49' : '#c8603b'}"/>
          ${[-1, 1].map((d) => [0, 1, 2, 3].map((k) => `<line x1="${d * 60}" y1="${-18 + k * 14}" x2="${d * 112}" y2="${-34 + k * 26}" stroke="${s.spoiled ? '#6a4a3b' : '#a94e2f'}" stroke-width="7"/>`).join('')).join('')}
          ${s.spoiled ? '<circle cx="-20" cy="-8" r="14" fill="#3f2d26"/><circle cx="24" cy="12" r="10" fill="#3f2d26"/>' : ''}
        </g>`;
      }
      return `${bg}<rect x="90" y="120" width="780" height="480" rx="14" fill="#eef1f2" stroke="#b9c1c4" stroke-width="4"/>${crabs}${challengeNote(s.code)}`;
    }
    case 'jacket':
      return `${bg}<g transform="translate(280 110)">
        <path d="M120 0 L280 0 L400 90 L340 190 L300 150 L300 500 L100 500 L100 150 L60 190 L0 90 Z" fill="${s.color}"/>
        <line x1="200" y1="10" x2="200" y2="500" stroke="rgba(255,255,255,.4)" stroke-width="4"/>
      </g>${challengeNote(s.code)}`;
    case 'box':
      return `${bg}<g transform="translate(190 150)">
        <rect width="580" height="400" fill="#c49a6c" stroke="#8f6c45" stroke-width="4"/>
        <rect x="255" width="70" height="400" fill="#e6d3ad" opacity=".85"/>
        <rect x="370" y="250" width="180" height="120" fill="#fbfbf6"/>
        ${s.dented ? '<polygon points="0,0 170,0 110,88 40,70 0,150" fill="#7c5a37"/>' : ''}
        ${s.open ? '<polygon points="0,0 580,0 500,-90 80,-90" fill="#b58a5c" stroke="#8f6c45" stroke-width="3"/>' : ''}
      </g>${challengeNote(s.code)}`;
    case 'label': {
      let bars = '';
      const r = rng(s.seed + 7);
      let x = 180;
      while (x < 780) {
        const w = 3 + r() * 11;
        bars += `<rect x="${x}" y="330" width="${w}" height="130" fill="#111"/>`;
        x += w + 3 + r() * 9;
      }
      return `${bg}<rect x="130" y="110" width="700" height="480" rx="6" fill="#fdfdf9" stroke="#cfcfc4"/>
        <text x="180" y="190" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#111">TRACKING</text>
        <text x="180" y="250" font-family="Menlo, monospace" font-size="42" fill="#111">${esc(s.tracking)}</text>
        <text x="180" y="300" font-family="Menlo, monospace" font-size="26" fill="#444">ZIP ${esc(s.zip)}</text>${bars}${challengeNote(s.code)}`;
    }
    case 'serial':
      return `${bg}<rect x="150" y="210" width="660" height="260" rx="12" fill="#f2f3f1" stroke="#b5b8b4" stroke-width="3"/>
        <text x="190" y="285" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#555">SERIAL NO.</text>
        <text x="190" y="380" font-family="Menlo, monospace" font-size="66" font-weight="700" fill="#111">${esc(s.serial)}</text>${challengeNote(s.code)}`;
    case 'contents': {
      let items = '';
      for (let i = 0; i < s.items; i++) items += mugShape(210 + i * 260, 240, '#9dbcae', false, 0.75);
      return `${bg}<rect x="120" y="130" width="720" height="480" fill="#d9b88d" stroke="#8f6c45" stroke-width="4"/>${items}${challengeNote(s.code)}`;
    }
    case 'chat': {
      let y = 150;
      let bubbles = '';
      for (const line of s.lines) {
        const w = Math.min(600, 80 + line.text.length * 15);
        const x = line.me ? W - 60 - w : 60;
        bubbles += `<rect x="${x}" y="${y}" width="${w}" height="74" rx="16" fill="${line.me ? '#a7e088' : '#ffffff'}"/>
          <text x="${x + 22}" y="${y + 47}" font-family="PingFang SC, Heiti SC, sans-serif" font-size="27" fill="#111">${esc(line.text)}</text>`;
        y += 100;
      }
      return `<rect width="${W}" height="${H}" fill="#ededed"/>
        <rect width="${W}" height="96" fill="#f7f7f7"/>
        <text x="${W / 2}" y="60" font-family="Helvetica, Arial, PingFang SC, sans-serif" font-size="30" fill="#111" text-anchor="middle">Store support · Order ${esc(s.orderNo)}</text>${bubbles}`;
    }
  }
}

export async function renderScene(scene: Scene): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${drawScene(scene)}
    <g opacity=".7">
      <rect x="${W - 274}" y="${H - 42}" width="260" height="30" rx="4" fill="rgba(255,255,255,.75)"/>
      <text x="${W - 144}" y="${H - 21}" font-family="Helvetica, Arial, sans-serif" font-size="17" fill="#333" text-anchor="middle">Demo placeholder · generated</text>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

/**
 * 在 JPEG 里写入一段 APP11（JUMBF）容器，内容模拟 AI 工具写入的 C2PA 清单。
 * 默认模拟从零生成（c2pa.created + trainedAlgorithmicMedia）；edited 模拟打开一张照片后用 AI 修改
 * （c2pa.opened + parentOf + compositeWithTrainedAlgorithmicMedia）。
 * 这不是有效签名的清单，只用来走通 Provenance 分析器的字节级解析。
 */
export function injectSimulatedC2PA(jpeg: Buffer, opts: { generator?: string; edited?: boolean } = {}): Buffer {
  const generator = opts.generator ?? 'ChatGPT';
  const actions = opts.edited
    ? ['c2pa.opened', 'parentOf', 'c2pa.edited', 'digitalSourceType', 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia']
    : ['c2pa.created', 'digitalSourceType', 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'];
  const fields = [
    'JP\u0000\u0000\u0000\u0000\u0000\u0001jumb',
    'jumdc2pa',
    'c2pa.claim',
    'claim_generator',
    generator,
    'c2pa.actions',
    ...actions,
  ];
  const manifest = Buffer.from(fields.join('\u0000'), 'latin1');
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xeb;
  header.writeUInt16BE(manifest.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, manifest, jpeg.subarray(2)]);
}

/** 模拟把别人的照片压缩、裁剪、调亮后再次提交。 */
export async function recompress(jpeg: Buffer): Promise<Buffer> {
  const meta = await sharp(jpeg).metadata();
  const w = meta.width!;
  const h = meta.height!;
  return sharp(jpeg)
    .extract({ left: Math.round(w * 0.02), top: Math.round(h * 0.02), width: Math.round(w * 0.96), height: Math.round(h * 0.96) })
    .modulate({ brightness: 1.06 })
    .jpeg({ quality: 62 })
    .toBuffer();
}
