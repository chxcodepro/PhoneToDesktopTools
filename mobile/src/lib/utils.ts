import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并 className（shadcn / react-native-reusables 同款） */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
