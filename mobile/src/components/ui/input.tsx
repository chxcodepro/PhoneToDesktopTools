import * as React from 'react';
import { TextInput } from 'react-native';

import { cn } from '@/lib/utils';

export type InputProps = React.ComponentProps<typeof TextInput> & { className?: string };

export function Input({ className, ...props }: InputProps) {
  return (
    <TextInput
      className={cn(
        'h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground',
        props.editable === false && 'opacity-50',
        className,
      )}
      placeholderTextColor="#94a3b8"
      {...props}
    />
  );
}
