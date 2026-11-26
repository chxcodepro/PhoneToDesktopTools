import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 秒数格式化为 HH:MM:SS */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const osName: Record<string, string> = { windows: 'Windows', linux: 'Linux', darwin: 'macOS' };
const archName: Record<string, string> = { amd64: 'x64', '386': 'x86', arm64: 'arm64' };

export function platformLabel(os?: string, arch?: string): string {
  if (!os) return '';
  return `${osName[os] ?? os} ${archName[arch ?? ''] ?? arch ?? ''}`.trim();
}
