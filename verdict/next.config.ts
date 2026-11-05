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
  serverExternalPackages: ['sharp'],
  devIndicators: false,
  allowedDevOrigins: lanAddresses(),
};

export default nextConfig;
