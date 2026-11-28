// 模型页：渠道预设（OpenAI / DeepSeek / 自定义）、API Key、模型、思考程度、上下文长度、系统提示词。
// 从抽屉的「模型」、设置页的「模型」卡片、首页「先配置大模型」进入。

import { ModelSettings } from '@/components/model-settings';
import { Screen } from '@/components/screen';

export default function ModelScreen() {
  return (
    <Screen title="模型">
      <ModelSettings />
    </Screen>
  );
}
