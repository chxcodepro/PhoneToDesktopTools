import { Pressable, View } from 'react-native';

import { cn } from '@/lib/utils';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/** shadcn 风格开关 */
export function Switch({ checked, onCheckedChange, disabled, className }: SwitchProps) {
  return (
    <Pressable
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onPress={() => onCheckedChange(!checked)}
      hitSlop={8}
      className={cn(
        'h-6 w-10 justify-center rounded-full px-0.5',
        checked ? 'bg-primary' : 'border border-border bg-muted',
        disabled && 'opacity-50',
        className,
      )}>
      <View className={cn('h-5 w-5 rounded-full bg-white shadow-sm', checked ? 'self-end' : 'self-start')} />
    </Pressable>
  );
}
