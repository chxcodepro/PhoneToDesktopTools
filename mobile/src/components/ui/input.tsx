import * as React from 'react';
import { TextInput } from 'react-native';

import { cn } from '@/lib/utils';

export type InputProps = React.ComponentProps<typeof TextInput> & { className?: string };

export function Input({ className, ...props }: InputProps) {
  return (
    <TextInput
      // Android 的 TextInput 自带上下内边距，固定高度时文字和提示会被截掉一半：去掉内边距并垂直居中
      className={cn(
        'h-10 rounded-md border border-input bg-background px-3 py-0 text-sm text-foreground',
        props.editable === false && 'opacity-50',
        className,
      )}
      textAlignVertical="center"
      placeholderTextColor="#94a3b8"
      {...props}
    />
  );
}
