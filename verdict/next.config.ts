import { networkInterfaces } from 'node:os';
import type { NextConfig } from 'next';

/** 手机测试（npm run dev:phone）时，Next 默认会拦截来自局域网地址的开发资源请求。 */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => net!.address);
}

const nextConfig: NextConfig = {
  serverExternalPackages: ['sharp', 'pdfkit'],
  devIndicators: false,
  allowedDevOrigins: lanAddresses(),
  experimental: {
    // proxy.ts 会把请求体缓存在内存里，默认只缓存 10MB，超出部分被截断。
    // 证据上传的上限是图片 15MB、视频 40MB，这里要大于它们加上表单开销。
    proxyClientMaxBodySize: '48mb',
  },
  async headers() {
    return [
      {
        // 控制台有资金动作按钮，不允许被别的网站嵌进 iframe 里诱导点击。
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
      {
        // 这些页面的地址里带一次性 token，任何外链都不带 Referer。
        source: '/(setup|invite|c)/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      { source: '/setup', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
    ];
  },
};

export default nextConfig;
