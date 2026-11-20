import { Pressable, View } from 'react-native';

import { cn } from '@/lib/utils';

import { Text } from './text';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (v: T) => void;
  className?: string;
}

/** 分段选择（shadcn Tabs 的 TabsList 样式） */
export function Segmented<T extends string>({ value, options, onChange, className }: SegmentedProps<T>) {
  return (
    <View className={cn('flex-row rounded-md bg-muted p-1', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            role="tab"
            aria-selected={on}
            onPress={() => onChange(o.value)}
            className={cn('flex-1 items-center rounded-sm py-1.5', on && 'bg-background shadow-sm')}>
            <Text className={cn('text-sm font-medium', on ? 'text-foreground' : 'text-muted-foreground')}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
