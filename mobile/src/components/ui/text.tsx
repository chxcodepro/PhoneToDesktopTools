import * as React from 'react';
import { Text as RNText } from 'react-native';

import { cn } from '@/lib/utils';

/** 父组件（如 Button）通过它给子 Text 传递默认样式，与 react-native-reusables 一致 */
export const TextClassContext = React.createContext<string | undefined>(undefined);

export type TextProps = React.ComponentProps<typeof RNText> & { className?: string };

export function Text({ className, ...props }: TextProps) {
  const inherited = React.useContext(TextClassContext);
  return <RNText className={cn('text-base text-foreground', inherited, className)} {...props} />;
}
