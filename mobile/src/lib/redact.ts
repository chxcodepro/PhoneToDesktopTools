// 日志脱敏（单独放，不依赖原生模块，方便测试）。

/** 去掉日志里可能出现的令牌、key（URL 参数、Bearer 头、sk- 开头的 key） */
export function redact(s: string): string {
  return s
    .replace(/([?&](?:token|key|api_key|apikey|access_token)=)[^&\s"']+/gi, '$1<已隐藏>')
    .replace(/(Bearer\s+)[\w.~+/=-]+/gi, '$1<已隐藏>')
    .replace(/\bsk-[\w-]{8,}/g, 'sk-<已隐藏>')
    .replace(/("(?:token|apiKey|api_key|secret|password)"\s*:\s*")[^"]*"/gi, '$1<已隐藏>"');
}
