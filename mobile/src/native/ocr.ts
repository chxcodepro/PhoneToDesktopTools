// 手机端离线文字识别（modules/p2d-ocr，Android ML Kit 中文模型）。iOS 暂未实现，ocrAvailable 为 false。

import { requireOptionalNativeModule } from 'expo';

import { formatOcr, parseScreenTransform, type OcrResult } from '@/agent/ocr';

interface P2dOcrModule {
  recognizeAsync(base64: string): Promise<OcrResult>;
}

const native = requireOptionalNativeModule<P2dOcrModule>('P2dOcr');

export const ocrAvailable = !!native;

/** 识别 base64 图片中的文字；不可用或失败时返回 null */
export async function recognizeText(base64: string): Promise<OcrResult | null> {
  if (!native) return null;
  try {
    return await native.recognizeAsync(base64);
  } catch {
    return null;
  }
}

/**
 * 给 Agent 用：把工具返回的截图转成文字。
 * context 是同一个工具返回的说明文字，screen_capture 的说明里有换算公式，用来直接给出屏幕坐标。
 */
export async function describeScreenshot(data: string, _mimeType: string, context?: string): Promise<string | null> {
  const r = await recognizeText(data);
  return r ? formatOcr(r, context ? parseScreenTransform(context) : null) : null;
}
